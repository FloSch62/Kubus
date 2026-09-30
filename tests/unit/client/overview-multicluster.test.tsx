import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterOverview, ContextInfo, MetricsSnapshot, NamespaceOverview } from '@kubus/shared';
import { OverviewPage } from '../../../client/src/pages/OverviewPage';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useOverviewPrefsStore } from '../../../client/src/state/overview-prefs';

const fixtures = vi.hoisted(() => ({
  overviews: {} as Record<string, ClusterOverview | undefined>,
  errors: {} as Record<string, Error | undefined>,
  nodeMetrics: {} as Record<string, MetricsSnapshot | undefined>,
  contexts: [] as ContextInfo[],
  namespaceOverview: undefined as NamespaceOverview | undefined,
  operatorCalls: [] as string[],
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResources: () => ({ data: [] }),
  useContexts: () => ({ data: fixtures.contexts }),
  useInstallMetricsServer: () => ({ mutate: vi.fn(), isPending: false }),
  useKubeconfigSettings: () => ({ data: undefined }),
  useNodeMetrics: (ctx: string) => ({ data: fixtures.nodeMetrics[ctx] }),
  useOverview: (ctx: string) => ({ data: fixtures.overviews[ctx], isLoading: false, error: fixtures.errors[ctx] ?? null }),
  useOverviewCertificates: () => ({ data: { total: 0, expiring: [] } }),
  useOverviewOperators: (ctx: string) => {
    fixtures.operatorCalls.push(ctx);
    return { data: [] };
  },
  useNamespaceOverview: () => ({ data: fixtures.namespaceOverview, isLoading: false, error: null }),
}));

vi.mock('../../../client/src/components/ClusterSectionHeader.js', () => ({
  ClusterSectionHeader: ({ ctx }: { ctx: string }) => <h2>{ctx}</h2>,
}));
vi.mock('../../../client/src/components/overview/NamespaceOverviewSection.js', () => ({ NamespaceOverviewSection: () => <p>namespace section</p> }));
vi.mock('../../../client/src/components/overview/PodUsagePanels.js', () => ({ PodUsagePanels: () => null }));

function overview(extra: Partial<ClusterOverview> = {}): ClusterOverview {
  return {
    counts: {
      nodes: 3,
      namespaces: 12,
      pods: 62,
      podsRunning: 52,
      deployments: 4,
      persistentVolumes: 0,
      persistentVolumesBound: 0,
      persistentVolumesUnavailable: false,
      crds: 0,
      crdsEstablished: 0,
      crdsUnavailable: false,
    },
    failingPods: [],
    unavailableWorkloads: [],
    recentRestarts: [],
    warningEvents: [],
    workloadHealth: [],
    ...extra,
  };
}

const metrics = (cpuMilli: number, memBytes: number): MetricsSnapshot => ({
  available: true,
  probed: true,
  totalCpuCapacityMilli: 4_000,
  totalMemCapacityBytes: 16 * 2 ** 30,
  items: [{ name: 'node-a', cpuMilli, memBytes, cpuCapacityMilli: 4_000, memCapacityBytes: 16 * 2 ** 30 }],
});

const summary = (ctx: string) => screen.getByRole('button', { name: new RegExp(`^${ctx}`) });

function renderPage() {
  return render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useClustersStore.setState({ selected: ['prod', 'staging'], namespaces: [], namespacesByContext: {} });
  useOverviewPrefsStore.setState({ expanded: {} });
  fixtures.overviews = {
    prod: overview({
      failingPods: [{ namespace: 'shop', name: 'api-1', phase: 'Running', reason: 'CrashLoopBackOff', restarts: 4 } as never],
      warningEvents: [{ reason: 'BackOff' } as never, { reason: 'BackOff' } as never],
    }),
    staging: overview(),
  };
  fixtures.errors = {};
  fixtures.nodeMetrics = { prod: metrics(3_700, 4 * 2 ** 30), staging: { available: false, probed: true, items: [] } };
  fixtures.contexts = [{ name: 'prod', cluster: 'prod', user: 'u', health: 'connected', active: true, kubernetesVersion: 'v1.36.1' }];
  fixtures.namespaceOverview = undefined;
  fixtures.operatorCalls = [];
});

describe('OverviewPage with several clusters', () => {
  it('starts every cluster as a summary of its major facts', () => {
    renderPage();
    const prod = summary('prod');
    expect(prod).toHaveAttribute('aria-expanded', 'false');
    expect(within(prod).getByText('v1.36.1 · 3 nodes · 12 namespaces')).toBeInTheDocument();
    expect(within(prod).getByText('failing pod')).toBeInTheDocument();
    expect(within(prod).getByText('warnings (1h)')).toBeInTheDocument();
    // CPU 3.7 of 4 cores is above 90%.
    expect(within(prod).getByText('93%')).toBeInTheDocument();
    expect(within(prod).getByText('25%')).toBeInTheDocument();

    const staging = summary('staging');
    expect(within(staging).getByText('Healthy')).toBeInTheDocument();
    expect(within(staging).getAllByText('no metrics')).toHaveLength(2);

    // Collapsed clusters don't load their operator rollups or render the full section.
    expect(fixtures.operatorCalls).toEqual([]);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('opens a cluster in place and remembers it', () => {
    renderPage();
    fireEvent.click(summary('staging'));
    expect(summary('staging')).toHaveAttribute('aria-expanded', 'true');
    expect(summary('prod')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(fixtures.operatorCalls).toContain('staging');
    expect(useOverviewPrefsStore.getState().expanded).toEqual({ staging: true });

    fireEvent.click(summary('staging'));
    expect(useOverviewPrefsStore.getState().expanded).toEqual({ staging: false });
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('expands and collapses all clusters from the page header', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(summary('prod')).toHaveAttribute('aria-expanded', 'true');
    expect(summary('staging')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('Needs attention')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(summary('prod')).toHaveAttribute('aria-expanded', 'false');
    expect(summary('staging')).toHaveAttribute('aria-expanded', 'false');
  });

  it('says a cluster is unreachable instead of summarising it', () => {
    fixtures.overviews.staging = undefined;
    fixtures.contexts = [...fixtures.contexts, { name: 'staging', cluster: 'staging', user: 'u', health: 'error', healthMessage: 'connect ECONNREFUSED 10.0.0.9:6443', active: false }];
    renderPage();
    const staging = summary('staging');
    expect(within(staging).getByText('Unreachable')).toBeInTheDocument();
    expect(within(staging).getByText(/ECONNREFUSED 10\.0\.0\.9:6443/)).toBeInTheDocument();
  });

  it('summarises the filtered namespaces when a cluster has a namespace filter', () => {
    useClustersStore.setState({ namespacesByContext: { staging: ['shop'] } });
    fixtures.namespaceOverview = {
      namespaces: ['shop'],
      status: 'Active',
      inventory: [
        { kind: 'Pod', group: '', version: 'v1', plural: 'pods', total: 7 },
        { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments', total: 2 },
      ],
      problems: [],
      workloadHealth: [],
      issues: [],
      failingPods: [],
      quotas: [],
      warningEvents: [],
    };
    renderPage();
    const staging = summary('staging');
    expect(within(staging).getByText('Namespace shop · Active')).toBeInTheDocument();
    expect(within(staging).getByText('7')).toBeInTheDocument();
    fireEvent.click(staging);
    expect(screen.getByText('namespace section')).toBeInTheDocument();
  });

  it('keeps a single cluster fully open, without a summary bar', () => {
    useClustersStore.setState({ selected: ['prod'] });
    renderPage();
    expect(screen.queryByRole('button', { name: 'Expand all' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });
});
