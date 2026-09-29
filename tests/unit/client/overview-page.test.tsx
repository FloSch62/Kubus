import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterOverview, MetricsSnapshot, OperatorRollup, OverviewCertificates } from '@kubus/shared';
import { OverviewPage } from '../../../client/src/pages/OverviewPage';
import { useClustersStore } from '../../../client/src/state/clusters';

const fixtures = vi.hoisted(() => ({
  overview: undefined as ClusterOverview | undefined,
  nodeMetrics: undefined as MetricsSnapshot | undefined,
  certificates: undefined as OverviewCertificates | undefined,
  operators: undefined as OperatorRollup[] | undefined,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResources: () => ({ data: [] }),
  useContexts: () => ({ data: [] }),
  useKubeconfigSettings: () => ({ data: undefined }),
  useNodeMetrics: () => ({ data: fixtures.nodeMetrics }),
  useOverview: () => ({ data: fixtures.overview, isLoading: false, error: null }),
  useOverviewCertificates: () => ({ data: fixtures.certificates }),
  useOverviewOperators: () => ({ data: fixtures.operators }),
}));

vi.mock('../../../client/src/components/ClusterSectionHeader.js', () => ({
  ClusterSectionHeader: ({ ctx }: { ctx: string }) => <h2>{ctx}</h2>,
}));
vi.mock('../../../client/src/components/overview/NamespaceOverviewSection.js', () => ({ NamespaceOverviewSection: () => null }));
vi.mock('../../../client/src/components/overview/PodUsagePanels.js', () => ({ PodUsagePanels: () => null }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <OverviewPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const node = (name: string) => ({ name, cpuMilli: 500, memBytes: 2 * 2 ** 30, cpuCapacityMilli: 2_000, memCapacityBytes: 8 * 2 ** 30 });

beforeEach(() => {
  useClustersStore.setState({ selected: ['dev'], namespaces: [], namespacesByContext: {} });
  fixtures.overview = {
    counts: {
      nodes: 1,
      namespaces: 1,
      pods: 62,
      podsRunning: 52,
      deployments: 0,
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
  };
  fixtures.certificates = { total: 0, expiring: [] };
  fixtures.operators = [];
  fixtures.nodeMetrics = {
    available: true,
    probed: true,
    totalCpuCapacityMilli: 6_000,
    totalMemCapacityBytes: 16 * 2 ** 30,
    items: [node('node-a')],
  };
});

describe('OverviewPage', () => {
  it('sums node usage into the inventory label and opens lists from the inventory buttons', () => {
    renderPage();
    expect(screen.getByText('CPU 8% · Memory 13% of 1 node')).toBeInTheDocument();
    // One node: the total says it all, no per-node card.
    expect(screen.queryByRole('heading', { name: 'Node usage' })).not.toBeInTheDocument();

    const pods = screen.getByRole('button', { name: 'Pods: 52 of 62 running' });
    expect(pods).toHaveAttribute('title', expect.stringContaining('The other 10 are pending, completed (Job pods) or failed'));
    fireEvent.click(pods);
    expect(screen.getByTestId('location')).toHaveTextContent('/r/core/v1/pods');
    fireEvent.click(screen.getByRole('button', { name: /^CRDs/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/r/apiextensions.k8s.io/v1/customresourcedefinitions');
  });

  it('lists per-node usage when there is more than one node', () => {
    fixtures.overview!.counts.nodes = 2;
    fixtures.nodeMetrics!.items = [node('node-a'), node('node-b')];
    renderPage();
    const card = screen.getByRole('heading', { name: 'Node usage' }).closest('div')!.parentElement!;
    expect(within(card).getByText('node-b')).toBeInTheDocument();
    expect(within(card).getAllByText('CPU 500m / 2.00 cores (25%)')).toHaveLength(2);
  });

  it('says nothing needs attention only once every source has answered', () => {
    fixtures.certificates = undefined;
    const { rerender } = renderPage();
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
    fixtures.certificates = { total: 0, expiring: [] };
    rerender(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('shows only the problem tiles, with breakdowns and working links', () => {
    useClustersStore.setState({ selected: ['dev', 'prod'], namespacesByContext: {} });
    fixtures.overview!.failingPods = [
      { namespace: 'a', name: 'p1', reason: 'ImagePullBackOff', restarts: 0 },
      { namespace: 'a', name: 'p2', reason: 'ErrImagePull', restarts: 0 },
      { namespace: 'a', name: 'p3', reason: 'CrashLoopBackOff', restarts: 9 },
    ];
    fixtures.overview!.warningEvents = [
      { namespace: 'a', reason: 'BackOff', message: 'x', involvedKind: 'Pod', involvedName: 'p3', count: 4 },
      { namespace: 'a', reason: 'BackOff', message: 'y', involvedKind: 'Pod', involvedName: 'p1', count: 2 },
      { namespace: 'a', reason: 'Failed', message: 'z', involvedKind: 'Pod', involvedName: 'p1', count: 2 },
    ];
    renderPage();
    const [first] = screen.getAllByRole('button', { name: '3 failing pods. Show pods' });
    expect(first).toHaveTextContent('2 ImagePull · 1 CrashLoop');
    expect(screen.getAllByRole('button', { name: '3 warnings, last hour. Show events' })[0]).toHaveTextContent('2 BackOff · 1 Failed');
    // Nothing unhealthy, no certificates due: those tiles stay out.
    expect(screen.queryByText(/unhealthy workload/)).not.toBeInTheDocument();
    expect(screen.queryByText(/certificates? expiring/)).not.toBeInTheDocument();

    fireEvent.click(first!);
    // Several clusters selected: the pods list is narrowed to this one.
    expect(screen.getByTestId('location')).toHaveTextContent(`/r/core/v1/pods?q=${encodeURIComponent('/cluster:dev status:unhealthy')}`);
  });
});
