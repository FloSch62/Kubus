import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryProblem, KubeObject, NamespaceOverview } from '@kubus/shared';
import { NamespaceDetail, problemsTone } from '../../../client/src/components/detail/NamespaceDetail';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useDetailStore } from '../../../client/src/state/detail';

const fixtures = vi.hoisted(() => ({
  overview: undefined as NamespaceOverview | undefined,
  navigate: vi.fn(),
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useNamespaceOverview: () => ({ data: fixtures.overview, isLoading: !fixtures.overview, error: null }),
}));
vi.mock('../../../client/src/app-navigate.js', () => ({ appNavigate: fixtures.navigate }));

const namespace: KubeObject = {
  apiVersion: 'v1',
  kind: 'Namespace',
  metadata: { name: 'gap', uid: 'ns-gap', labels: { team: 'platform' } },
  status: { phase: 'Active' },
};

function entry(kind: string, group: string, plural: string, total: number, health?: { healthy: number; degraded: number; failed: number }) {
  return { kind, group, version: 'v1', plural, total, health };
}

function problem(p: Omit<InventoryProblem, 'version' | 'namespace'>): InventoryProblem {
  return { version: 'v1', namespace: 'gap', ...p };
}

beforeEach(() => {
  fixtures.navigate.mockClear();
  useClustersStore.setState({ selected: ['dev'], namespaces: [], namespacesByContext: {} });
  useDetailStore.setState({ stack: [], dataDirty: false });
  fixtures.overview = {
    namespaces: ['gap'],
    status: 'Active',
    inventory: [
      entry('Pod', '', 'pods', 4, { healthy: 2, degraded: 1, failed: 1 }),
      entry('Deployment', 'apps', 'deployments', 3, { healthy: 2, degraded: 0, failed: 1 }),
      entry('DaemonSet', 'apps', 'daemonsets', 0, { healthy: 0, degraded: 0, failed: 0 }),
      entry('ConfigMap', '', 'configmaps', 2),
      { ...entry('Certificate', 'cert-manager.io', 'certificates', 1, { healthy: 0, degraded: 0, failed: 1 }), custom: true },
    ],
    problems: [
      problem({ kind: 'Pod', group: '', plural: 'pods', name: 'broken-abc', grade: 'failed', reason: 'ImagePullBackOff', message: 'registry.invalid not found' }),
      problem({ kind: 'Deployment', group: 'apps', plural: 'deployments', name: 'broken', grade: 'failed', reason: 'Unavailable', ready: 0, desired: 1 }),
      problem({ kind: 'Certificate', group: 'cert-manager.io', plural: 'certificates', name: 'tls', grade: 'failed', reason: 'Failed', message: 'issuer not found', custom: true }),
      problem({ kind: 'Pod', group: '', plural: 'pods', name: 'starting', grade: 'degraded', reason: 'ContainerCreating' }),
    ],
    workloadHealth: [],
    issues: [{ kind: 'Deployment', namespace: 'gap', name: 'broken', ready: 0, desired: 1, reason: 'Unavailable' }],
    failingPods: [{ namespace: 'gap', name: 'broken-abc', reason: 'ImagePullBackOff', message: 'registry.invalid not found', restarts: 0 }],
    quotas: [{ name: 'gap-quota', resources: [{ resource: 'pods', used: '5', hard: '6', pct: 83.3 }] }],
    warningEvents: [],
  };
});

describe('NamespaceDetail', () => {
  it('shows each kind with its health split and the empty kinds behind a toggle', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    expect(screen.getByRole('button', { name: 'Pods: 4, 2 healthy, 1 degraded, 1 failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deployments: 3, 2 healthy, 1 failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ConfigMaps: 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Certificates: 1, 1 failed' })).toBeInTheDocument();
    expect(screen.getByText('Custom resources')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'DaemonSets' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Show \d+ empty kinds?$/ }));
    expect(screen.getByRole('button', { name: 'DaemonSets' })).toBeInTheDocument();
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
  });

  it('says visibly when a kind could not be read', () => {
    fixtures.overview!.inventory.push({ ...entry('Secret', '', 'secrets', 0), unavailable: true });
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    expect(screen.getByRole('button', { name: 'Secrets: unavailable' })).toHaveTextContent('no access');
  });

  it('opens a kind list narrowed to this namespace through the cluster filter', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    fireEvent.click(screen.getByRole('button', { name: 'Deployments: 3, 2 healthy, 1 failed' }));
    expect(useClustersStore.getState().namespacesByContext.dev).toEqual(['gap']);
    expect(fixtures.navigate).toHaveBeenCalledWith('/r/apps/v1/deployments');

    fireEvent.click(screen.getByRole('button', { name: /^Show \d+ empty kinds?$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'DaemonSets' }));
    expect(fixtures.navigate).toHaveBeenLastCalledWith('/r/apps/v1/daemonsets');
  });

  it('lists workload, pod and operator problems that open in the drawer', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    fireEvent.click(screen.getByRole('button', { name: 'Deployment broken' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Deployment', group: 'apps', plural: 'deployments', name: 'broken', namespace: 'gap' });
    fireEvent.click(screen.getByRole('button', { name: 'Pod broken-abc' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Pod', name: 'broken-abc' });
    fireEvent.click(screen.getByRole('button', { name: 'Certificate tls' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'Certificate', group: 'cert-manager.io', custom: true });
    expect(screen.getByText('issuer not found')).toBeInTheDocument();
  });

  it('explains a failed route that no workload check covers, and says so up top', () => {
    fixtures.overview = {
      ...fixtures.overview!,
      inventory: [{ ...entry('HTTPRoute', 'gateway.networking.k8s.io', 'httproutes', 1, { healthy: 0, degraded: 0, failed: 1 }), custom: true }],
      problems: [
        problem({ kind: 'HTTPRoute', group: 'gateway.networking.k8s.io', plural: 'httproutes', name: 'orphan', grade: 'failed', reason: 'NoMatchingParent', message: 'Gateway missing-gw not found', custom: true }),
      ],
      issues: [],
      failingPods: [],
    };
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    const tile = screen.getByText('Problems', { selector: 'dt' }).closest('div')!;
    expect(within(tile).getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Gateway missing-gw not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'HTTPRoute orphan' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'HTTPRoute', group: 'gateway.networking.k8s.io', plural: 'httproutes', name: 'orphan', custom: true });
  });

  it('takes the problems tone from the same grades as the bars', () => {
    expect(problemsTone([])).toBe('success');
    expect(problemsTone([problem({ kind: 'Pod', group: '', plural: 'pods', name: 'a', grade: 'degraded', reason: 'NotReady' })])).toBe('warning');
    expect(
      problemsTone([
        problem({ kind: 'Pod', group: '', plural: 'pods', name: 'a', grade: 'degraded', reason: 'NotReady' }),
        problem({ kind: 'HTTPRoute', group: 'gateway.networking.k8s.io', plural: 'httproutes', name: 'r', grade: 'failed', reason: 'NoMatchingParent' }),
      ]),
    ).toBe('error');
  });

  it('shows quota usage inline and opens the quota', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    const strip = screen.getByText('Quota use').closest('div')!;
    expect(within(strip).getByText('83%')).toBeInTheDocument();
    expect(screen.getByText('5 / 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'gap-quota' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'ResourceQuota', name: 'gap-quota', namespace: 'gap' });
  });
});
