import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterOverview, MetricsSnapshot, OperatorRollup, OverviewCertificates } from '@kubus/shared';
import { OverviewPage } from '../../../client/src/pages/OverviewPage';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useOverviewPrefsStore } from '../../../client/src/state/overview-prefs';

const fixtures = vi.hoisted(() => ({
  overview: undefined as ClusterOverview | undefined,
  nodeMetrics: undefined as MetricsSnapshot | undefined,
  certificates: undefined as OverviewCertificates | undefined,
  operators: undefined as OperatorRollup[] | undefined,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResources: () => ({ data: [] }),
  useContexts: () => ({ data: [] }),
  useInstallMetricsServer: () => ({ mutate: vi.fn(), isPending: false }),
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
  it('shows the single node as the usage total and opens lists from the inventory buttons', () => {
    renderPage();
    const card = screen.getByRole('heading', { name: 'Node usage' }).closest('[data-anchor]') as HTMLElement;
    // One node: the meters are that node, named in the header, no per-node table.
    expect(within(card).getByRole('link', { name: 'node-a' })).toHaveAttribute('href', `/r/core/v1/nodes?sel=${encodeURIComponent('dev||node-a')}`);
    expect(within(card).getByText('8%')).toBeInTheDocument();
    expect(within(card).getByText('500m of 6 cores in use')).toBeInTheDocument();
    expect(within(card).getByText('2.0 of 16.0Gi in use')).toBeInTheDocument();
    expect(within(card).queryByRole('table')).not.toBeInTheDocument();

    const pods = screen.getByRole('button', { name: 'Pods: 52 of 62 running' });
    expect(pods).toHaveAttribute('title', expect.stringContaining('The other 10 are pending, completed (Job pods) or failed'));
    fireEvent.click(pods);
    expect(screen.getByTestId('location')).toHaveTextContent('/r/core/v1/pods');
    fireEvent.click(screen.getByRole('button', { name: /^CRDs/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/r/apiextensions.k8s.io/v1/customresourcedefinitions');
  });

  it('adds a total row and lists the nodes busiest first when there are several', () => {
    fixtures.overview!.counts.nodes = 3;
    fixtures.nodeMetrics = {
      available: true,
      probed: true,
      items: [node('node-a'), { ...node('node-b'), cpuMilli: 1_800 }, node('node-c')],
    };
    renderPage();
    const card = screen.getByRole('heading', { name: 'Node usage' }).closest('[data-anchor]') as HTMLElement;
    expect(within(card).getByText('2.8 of 6 cores in use')).toBeInTheDocument();
    const rows = within(within(card).getByRole('table', { name: 'Usage per node' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(['node-b', 'node-a', 'node-c']);
    expect(within(rows[0]!).getByText('1.8 / 2 cores')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('500m / 2 cores')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('2.0 / 8.0Gi')).toBeInTheDocument();
  });

  it('caps long node lists behind a toggle', () => {
    fixtures.overview!.counts.nodes = 11;
    fixtures.nodeMetrics = { available: true, probed: true, items: Array.from({ length: 11 }, (_, i) => node(`node-${i}`)) };
    renderPage();
    const table = screen.getByRole('table', { name: 'Usage per node' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 11 nodes' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 11);
  });

  it('keeps the node usage card while metrics load or are missing', () => {
    fixtures.nodeMetrics = { available: false, probed: false, items: [] };
    const { rerender } = renderPage();
    expect(screen.getByRole('heading', { name: 'Node usage' })).toBeInTheDocument();
    expect(screen.getByLabelText('Loading node usage')).toBeInTheDocument();

    fixtures.nodeMetrics = { available: false, probed: true, items: [] };
    rerender(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/metrics-server is not serving data/)).toBeInTheDocument();
  });

  it('shows every checked kind in the inventory, with unhealthy counts and unreadable kinds', () => {
    fixtures.overview!.workloadHealth = [
      { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments', total: 3, unhealthy: 1 },
      { kind: 'DaemonSet', group: 'apps', version: 'v1', plural: 'daemonsets', total: 0, unhealthy: 0, unavailable: true },
      { kind: 'PodDisruptionBudget', group: 'policy', version: 'v1', plural: 'poddisruptionbudgets', total: 0, unhealthy: 0 },
    ];
    renderPage();
    const daemonSets = screen.getByRole('button', { name: 'DaemonSets: no access' });
    expect(daemonSets).toHaveTextContent('no access');
    expect(screen.getByRole('button', { name: 'PodDisruptionBudgets: 0' })).toHaveTextContent('PDBs');
    // Healthy otherwise, but the verdict names what it could not look at.
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    expect(screen.getByText('Could not check DaemonSets: no access.')).toBeInTheDocument();

    const deployments = screen.getByRole('button', { name: 'Deployments: 3, 1 unhealthy' });
    expect(deployments).toHaveTextContent('1 unhealthy');
    fireEvent.click(deployments);
    expect(screen.getByTestId('location')).toHaveTextContent(`/r/apps/v1/deployments?q=${encodeURIComponent('/status:unhealthy')}`);
    fireEvent.click(screen.getByRole('button', { name: 'PodDisruptionBudgets: 0' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/r/policy/v1/poddisruptionbudgets');
  });

  it('says so when persistent volumes cannot be listed, and flags unbound ones', () => {
    fixtures.overview!.counts.persistentVolumesUnavailable = true;
    const { unmount } = renderPage();
    expect(screen.getByRole('button', { name: 'PVs: unavailable' })).toHaveTextContent('unavailable');
    unmount();

    fixtures.overview!.counts = { ...fixtures.overview!.counts, persistentVolumesUnavailable: false, persistentVolumes: 5, persistentVolumesBound: 3 };
    renderPage();
    expect(screen.getByRole('button', { name: 'PVs: 3 of 5 bound' })).toHaveTextContent('2 not bound');
  });

  it('counts tracked TLS certificates and opens cert-manager Certificates when installed', () => {
    fixtures.certificates = {
      total: 5,
      expiring: [{ source: 'tls-secret', kind: 'Secret', group: '', version: 'v1', plural: 'secrets', namespace: 'a', name: 'web-tls', notAfter: new Date(Date.now() + 5 * 86_400_000).toISOString() }],
    };
    const { unmount } = renderPage();
    const button = screen.getByRole('button', { name: 'TLS certificates: 5 tracked, 1 expiring' });
    expect(button).toHaveTextContent('1 expiring');
    fireEvent.click(button);
    expect(screen.getByTestId('location')).toHaveTextContent('/r/core/v1/secrets');
    unmount();

    fixtures.operators = [
      {
        id: 'cert-manager',
        name: 'cert-manager',
        resources: [{ kind: 'Certificate', group: 'cert-manager.io', version: 'v1', plural: 'certificates', namespaced: true, total: 1, ready: 1, issues: [] }],
      },
    ];
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^TLS certificates: 5 tracked/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/r/cert-manager.io/v1/certificates');
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
    // Several clusters start as summaries; open both.
    useOverviewPrefsStore.setState({ expanded: { dev: true, prod: true } });
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
