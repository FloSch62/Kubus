import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { KubeObject } from '@kubus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { bulkScaleScopes, bulkScaleTargets, commonReplicas, HPA_LOOKUPS_PER_CLUSTER, indexHpas, planBulkScale } from '../../../client/src/components/bulk-scale';
import { BulkScaleDialog } from '../../../client/src/components/BulkScaleDialog';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const mocks = vi.hoisted(() => ({
  hpas: {} as Record<string, KubeObject[]>,
  /** Clusters whose cluster-wide HPA list fails. */
  clusterWideDenied: new Set<string>(),
  lookups: [] as string[],
  scale: vi.fn(async (_args: unknown) => ({ ok: true })),
  toast: vi.fn(),
}));

// HPA lookups answer from `mocks.hpas`, keyed by cluster and namespace; a
// cluster-wide lookup (no namespace) returns every HPA of that cluster.
vi.mock('@tanstack/react-query', () => ({
  useQueries: (config: { queries: Array<{ queryKey: [string, { ctx: string; namespace?: string }] }>; combine: (results: unknown[]) => unknown }) =>
    config.combine(
      config.queries.map((q) => {
        const { ctx, namespace } = q.queryKey[1];
        mocks.lookups.push(namespace === undefined ? `${ctx}/*` : `${ctx}/${namespace}`);
        if (namespace === undefined) {
          if (mocks.clusterWideDenied.has(ctx)) return { data: undefined, isLoading: false, isError: true };
          const items = Object.entries(mocks.hpas).flatMap(([key, list]) => (key.startsWith(`${ctx}/`) ? list : []));
          return { data: { items }, isLoading: false, isError: false };
        }
        return { data: { items: mocks.hpas[`${ctx}/${namespace}`] ?? [] }, isLoading: false, isError: false };
      }),
    ),
}));
vi.mock('../../../client/src/api/queries.js', () => ({ useScale: () => ({ mutateAsync: mocks.scale }) }));
vi.mock('../../../client/src/state/toast.js', () => ({ showToast: mocks.toast }));

function deployment(name: string, replicas: number, ctx = 'dev', namespace = 'gap-lists'): ClusterRow {
  return { ctx, obj: { metadata: { name, namespace, uid: `${ctx}-${name}` }, spec: { replicas } } as KubeObject };
}

function hpa(target: string, extra: Partial<KubeObject['metadata']> = {}): KubeObject {
  return {
    metadata: { name: `${target}-hpa`, namespace: 'gap-lists', uid: `hpa-${target}`, ...extra },
    spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: target }, minReplicas: 2, maxReplicas: 5 },
  } as KubeObject;
}

describe('bulk scale planning', () => {
  const rows = [deployment('api', 2), deployment('web', 3), deployment('worker', 3, 'prod')];
  const hpas: Record<string, KubeObject[]> = { 'dev/gap-lists': [hpa('web')] };
  const targets = bulkScaleTargets(rows, 'Deployment', 'apps', (ctx, ns) => hpas[`${ctx}/${ns}`]);

  it('looks up autoscalers once per cluster and namespace', () => {
    expect(bulkScaleScopes([...rows, deployment('other', 1)])).toEqual([
      { ctx: 'dev', namespace: 'gap-lists' },
      { ctx: 'prod', namespace: 'gap-lists' },
    ]);
  });

  it('finds the autoscaler of each workload in its own cluster', () => {
    expect(targets.map((t) => [t.row.obj.metadata.name, t.current, t.scaler?.name])).toEqual([
      ['api', 2, undefined],
      ['web', 3, 'web-hpa'],
      ['worker', 3, undefined],
    ]);
  });

  it('skips autoscaled workloads unless overridden', () => {
    const plan = planBulkScale(targets, 4, false, () => false);
    expect(plan.apply.map((t) => t.row.obj.metadata.name)).toEqual(['api', 'worker']);
    expect(plan.skipped.map((t) => t.row.obj.metadata.name)).toEqual(['web']);
    expect(planBulkScale(targets, 4, true, () => false).apply).toHaveLength(3);
  });

  it('guards scaling running workloads on a protected cluster to zero', () => {
    const prod = (ctx: string) => ctx === 'prod';
    expect(planBulkScale(targets, 0, false, prod).guarded).toBe(true);
    expect(planBulkScale(targets, 1, false, prod).guarded).toBe(false);
    expect(planBulkScale(targets, 0, false, () => false).guarded).toBe(false);
    const idle = bulkScaleTargets([deployment('idle', 0, 'prod')], 'Deployment', 'apps', () => undefined);
    expect(planBulkScale(idle, 0, false, prod).guarded).toBe(false);
  });

  it('proposes the replica count the targets share', () => {
    expect(commonReplicas(targets)).toBeUndefined();
    expect(commonReplicas(targets.slice(1))).toBe(3);
  });

  it('marks skipped workloads by uid', () => {
    expect([...planBulkScale(targets, 4, false, () => false).skippedUids]).toEqual(['dev-web']);
    expect(planBulkScale(targets, 4, true, () => false).skippedUids.size).toBe(0);
  });
});

describe('HPA lookups for many namespaces', () => {
  const spread = (ctx: string, count: number) => Array.from({ length: count }, (_, i) => deployment(`app-${i}`, 1, ctx, `ns-${i}`));

  it('lists once per cluster past a few namespaces, and per namespace below that', () => {
    const rows = [...spread('big', HPA_LOOKUPS_PER_CLUSTER + 1), ...spread('small', HPA_LOOKUPS_PER_CLUSTER)];
    const scopes = bulkScaleScopes(rows);
    expect(scopes.filter((s) => s.ctx === 'big')).toEqual([{ ctx: 'big' }]);
    expect(scopes.filter((s) => s.ctx === 'small')).toHaveLength(HPA_LOOKUPS_PER_CLUSTER);
  });

  it('falls back to per-namespace lookups for clusters that denied the cluster-wide list', () => {
    const scopes = bulkScaleScopes(spread('big', 200), new Set(['big']));
    expect(scopes).toHaveLength(200);
    expect(scopes[0]).toEqual({ ctx: 'big', namespace: 'ns-0' });
  });

  it('splits a cluster-wide list by namespace', () => {
    const lookup = indexHpas(
      [{ ctx: 'big' }, { ctx: 'small', namespace: 'a' }, { ctx: 'failed', namespace: 'b' }],
      [[hpa('web', { namespace: 'ns-1' }), hpa('api', { namespace: 'ns-2', uid: 'hpa-api' })], [hpa('db', { namespace: 'a' })], undefined],
    );
    expect(lookup('big', 'ns-1')?.map((h) => h.metadata.name)).toEqual(['web-hpa']);
    expect(lookup('big', 'ns-9')).toEqual([]);
    expect(lookup('small', 'a')?.map((h) => h.metadata.name)).toEqual(['db-hpa']);
    expect(lookup('failed', 'b')).toBeUndefined();
  });
});

function renderDialog(rows: ClusterRow[]) {
  const onClose = vi.fn();
  render(<BulkScaleDialog rows={rows} kind="Deployment" group="apps" version="v1" plural="deployments" title="Deployments" onClose={onClose} />);
  return onClose;
}

describe('BulkScaleDialog', () => {
  beforeEach(() => {
    mocks.hpas = { 'dev/gap-lists': [hpa('web')] };
    mocks.clusterWideDenied = new Set();
    mocks.lookups = [];
    mocks.scale.mockClear();
    mocks.toast.mockClear();
    useClustersStore.setState({ contextSettings: {} });
    useUiPrefsStore.setState({ protectByDefault: false });
  });

  it('warns about the autoscaler, skips that workload by default and scales the rest', async () => {
    const onClose = renderDialog([deployment('api', 3), deployment('web', 3)]);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 2 Deployments' });
    expect(await within(dialog).findByText(/managed by an autoscaler/)).toHaveTextContent('web by HorizontalPodAutoscaler web-hpa (min 2 / max 5)');
    expect(within(dialog).getByText('3 · autoscaled, skipped')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Increase replicas' }));
    expect(within(dialog).getByText('3 → 4')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scale 1 of 2' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.scale).toHaveBeenCalledTimes(1);
    expect(mocks.scale).toHaveBeenCalledWith({
      ctx: 'dev',
      body: { group: 'apps', version: 'v1', plural: 'deployments', namespace: 'gap-lists', name: 'api', replicas: 4 },
    });
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Scaled 1 Deployment to 4; 1 autoscaled left alone');
  });

  it('scales autoscaled workloads too once the override is checked', async () => {
    renderDialog([deployment('api', 3), deployment('web', 3)]);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 2 Deployments' });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Override the autoscaler/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scale 2' }));
    await waitFor(() => expect(mocks.scale).toHaveBeenCalledTimes(2));
  });

  it('asks for typed confirmation before scaling a protected cluster to zero', async () => {
    useClustersStore.setState({ contextSettings: { dev: { protected: true } } });
    mocks.hpas = {};
    renderDialog([deployment('api', 3), deployment('worker', 2)]);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 2 Deployments' });
    const input = within(dialog).getByRole('spinbutton', { name: 'Replicas' });
    fireEvent.change(input, { target: { value: '0' } });
    const scaleButton = await within(dialog).findByRole('button', { name: 'Scale 2' });
    expect(scaleButton).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('scale 2 to 0'), { target: { value: 'scale 2 to 0' } });
    expect(scaleButton).toBeEnabled();
  });

  it('lists HPAs once for a selection across many namespaces and still finds the autoscaled one', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => deployment(`app-${i}`, 1, 'dev', `ns-${i}`));
    mocks.hpas = { 'dev/ns-4': [hpa('app-4', { namespace: 'ns-4' })] };
    renderDialog(rows);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 6 Deployments' });
    expect(within(dialog).getByText(/managed by an autoscaler/)).toHaveTextContent('app-4 by HorizontalPodAutoscaler app-4-hpa');
    expect(new Set(mocks.lookups)).toEqual(new Set(['dev/*']));
  });

  it('falls back to namespace lookups when the cluster-wide list is denied', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => deployment(`app-${i}`, 1, 'dev', `ns-${i}`));
    mocks.hpas = { 'dev/ns-4': [hpa('app-4', { namespace: 'ns-4' })] };
    mocks.clusterWideDenied = new Set(['dev']);
    renderDialog(rows);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 6 Deployments' });
    expect(await within(dialog).findByText(/managed by an autoscaler/)).toHaveTextContent('app-4 by HorizontalPodAutoscaler app-4-hpa');
    expect(mocks.lookups).toContain('dev/ns-4');
    expect(within(dialog).getByRole('button', { name: 'Scale 5 of 6' })).toBeEnabled();
  });

  it('guards against the live replica count, not the one seen when the rows were checked', async () => {
    useClustersStore.setState({ contextSettings: { dev: { protected: true } } });
    mocks.hpas = {};
    const onClose = vi.fn();
    const idle = deployment('api', 0);
    const { rerender } = render(<BulkScaleDialog rows={[idle]} kind="Deployment" group="apps" version="v1" plural="deployments" title="Deployments" onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 1 Deployment' });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '0' } });
    expect(within(dialog).queryByPlaceholderText('scale 1 to 0')).not.toBeInTheDocument();
    // Someone scaled it up while the dialog was open.
    rerender(<BulkScaleDialog rows={[deployment('api', 3)]} kind="Deployment" group="apps" version="v1" plural="deployments" title="Deployments" onClose={onClose} />);
    expect(await within(dialog).findByPlaceholderText('scale 1 to 0')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Scale 1' })).toBeDisabled();
  });

  it('reports failures with the first error', async () => {
    mocks.hpas = {};
    mocks.scale.mockImplementationOnce(async () => {
      throw new Error('forbidden');
    });
    renderDialog([deployment('api', 1), deployment('worker', 1)]);
    const dialog = await screen.findByRole('dialog', { name: 'Scale 2 Deployments' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Scale 2' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', 'Scale failed for 1 of 2 — api: forbidden'));
  });
});
