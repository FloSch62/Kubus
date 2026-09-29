import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { KubeObject } from '@kubus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterRow } from '../../../client/src/api/queries';
import { bulkScaleScopes, bulkScaleTargets, commonReplicas, planBulkScale } from '../../../client/src/components/bulk-scale';
import { BulkScaleDialog } from '../../../client/src/components/BulkScaleDialog';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const mocks = vi.hoisted(() => ({
  hpas: {} as Record<string, KubeObject[]>,
  scale: vi.fn(async (_args: unknown) => ({ ok: true })),
  toast: vi.fn(),
}));

// HPA lookups answer from `mocks.hpas`, keyed by cluster and namespace.
vi.mock('@tanstack/react-query', () => ({
  useQueries: (config: { queries: Array<{ queryKey: [string, { ctx: string; namespace: string }] }>; combine: (results: unknown[]) => unknown }) =>
    config.combine(config.queries.map((q) => ({ data: { items: mocks.hpas[`${q.queryKey[1].ctx}/${q.queryKey[1].namespace}`] ?? [] }, isLoading: false }))),
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
});

function renderDialog(rows: ClusterRow[]) {
  const onClose = vi.fn();
  render(<BulkScaleDialog rows={rows} kind="Deployment" group="apps" version="v1" plural="deployments" title="Deployments" onClose={onClose} />);
  return onClose;
}

describe('BulkScaleDialog', () => {
  beforeEach(() => {
    mocks.hpas = { 'dev/gap-lists': [hpa('web')] };
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
