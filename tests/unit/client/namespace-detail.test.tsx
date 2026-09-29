import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject, NamespaceOverview, OperatorRollup } from '@kubus/shared';
import { NamespaceDetail } from '../../../client/src/components/detail/NamespaceDetail';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useDetailStore } from '../../../client/src/state/detail';

const fixtures = vi.hoisted(() => ({
  overview: undefined as NamespaceOverview | undefined,
  operators: undefined as OperatorRollup[] | undefined,
  navigate: vi.fn(),
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useNamespaceOverview: () => ({ data: fixtures.overview, isLoading: !fixtures.overview, error: null }),
  useOverviewOperators: () => ({ data: fixtures.operators }),
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

beforeEach(() => {
  fixtures.navigate.mockClear();
  useClustersStore.setState({ selected: ['dev'], namespaces: [], namespacesByContext: {} });
  useDetailStore.setState({ stack: [], dataDirty: false });
  fixtures.operators = [
    {
      id: 'cert-manager',
      name: 'cert-manager',
      resources: [
        {
          kind: 'Certificate',
          group: 'cert-manager.io',
          version: 'v1',
          plural: 'certificates',
          namespaced: true,
          total: 1,
          ready: 0,
          issues: [{ kind: 'Certificate', namespace: 'gap', name: 'tls', reason: 'Failed', message: 'issuer not found' }],
        },
      ],
    },
  ];
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
    workloadHealth: [],
    issues: [{ kind: 'Deployment', namespace: 'gap', name: 'broken', ready: 0, desired: 1, reason: 'Unavailable' }],
    failingPods: [{ namespace: 'gap', name: 'broken-abc', reason: 'ImagePullBackOff', message: 'registry.invalid not found', restarts: 0 }],
    quotas: [{ name: 'gap-quota', resources: [{ resource: 'pods', used: '5', hard: '6', pct: 83.3 }] }],
    warningEvents: [],
  };
});

describe('NamespaceDetail', () => {
  it('shows each kind with a health bar split and the empty kinds as links', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    expect(screen.getByRole('button', { name: 'Pods: 4, 2 healthy, 1 degraded, 1 failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deployments: 3, 2 healthy, 1 failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ConfigMaps: 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Certificates: 1, 1 failed' })).toBeInTheDocument();
    expect(screen.getByText('Custom resources')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DaemonSets' })).toBeInTheDocument();
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
  });

  it('opens a kind list narrowed to this namespace through the cluster filter', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    fireEvent.click(screen.getByRole('button', { name: 'Deployments: 3, 2 healthy, 1 failed' }));
    expect(useClustersStore.getState().namespacesByContext.dev).toEqual(['gap']);
    expect(fixtures.navigate).toHaveBeenCalledWith('/r/apps/v1/deployments');

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

  it('shows quota usage inline and opens the quota', () => {
    render(<NamespaceDetail obj={namespace} ctx="dev" />);
    const strip = screen.getByText('Quota use').closest('div')!;
    expect(within(strip).getByText('83%')).toBeInTheDocument();
    expect(screen.getByText('5 / 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'gap-quota' }));
    expect(useDetailStore.getState().stack.at(-1)).toMatchObject({ kind: 'ResourceQuota', name: 'gap-quota', namespace: 'gap' });
  });
});
