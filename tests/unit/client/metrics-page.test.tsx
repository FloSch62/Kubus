import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterMetricsSummary, MetricsServerStatus } from '@kubus/shared';
import { MetricsPage } from '../../../client/src/pages/MetricsPage';
import { useClustersStore } from '../../../client/src/state/clusters';

// MetricsPage reaches for the query client; the client project's react-query
// harness needs registering before the page module loads.
vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for('kubus.test.query-harness'), {
    queryConfigs: [],
    mutationConfigs: [],
    multiQueryConfigs: [],
    queryResults: new Map(),
    queryClient: {},
  });
});

const fixtures = vi.hoisted(() => ({
  status: undefined as MetricsServerStatus | undefined,
  summary: undefined as ClusterMetricsSummary | undefined,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useMetricsServerStatus: () => ({ data: fixtures.status, error: null }),
  useMetricsSummary: () => ({ data: fixtures.summary, error: null }),
  invalidateMetricsServer: vi.fn(),
  useInstallMetricsServer: () => ({ mutate: vi.fn(), isPending: false }),
  useUninstallMetricsServer: () => ({ mutate: vi.fn(), isPending: false }),
  useContexts: () => ({ data: [] }),
}));

const GiB = 1024 ** 3;
const series = [
  { t: Date.parse('2026-09-29T18:15:00Z'), cpuMilli: 250, memBytes: 1.7 * GiB },
  { t: Date.parse('2026-09-29T18:16:00Z'), cpuMilli: 280, memBytes: 1.8 * GiB },
];

beforeEach(() => {
  useClustersStore.setState({ selected: ['kind-a'], namespaces: [], namespacesByContext: {} });
  fixtures.status = { installed: true, managedByKubus: true, ready: true, version: 'v0.9.0' } as MetricsServerStatus;
  fixtures.summary = {
    available: true,
    clusterSeries: series,
    cpuCapacityMilli: 12000,
    memCapacityBytes: 46 * GiB,
    nodes: [{ name: 'node-a', series }],
    topPodsCpu: [{ name: 'kube-apiserver-kind-control-plane', namespace: 'kube-system', series: [{ ...series[1]!, cpuMilli: 70 }] }],
    topPodsMem: [{ name: 'etcd-kind-control-plane', namespace: 'kube-system', series: [{ ...series[1]!, memBytes: 700 * 1024 ** 2 }] }],
    namespaces: [{ namespace: 'kube-system', pods: 9, cpuMilli: 113, memBytes: GiB }],
    podCount: 49,
  } as ClusterMetricsSummary;
});

describe('MetricsPage', () => {
  it('names the page and puts the single cluster and its controls in the header', () => {
    render(<MetricsPage />);
    expect(screen.getByRole('heading', { name: 'Metrics' })).toBeInTheDocument();
    expect(screen.getByText('kind-a')).toBeInTheDocument();
    expect(screen.getByText('metrics-server v0.9.0')).toBeInTheDocument();
    // Uninstall hides behind the ⋮ menu instead of a red header button.
    expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More metrics-server actions for kind-a' }));
    expect(screen.getByRole('menuitem', { name: /Uninstall metrics-server/ })).toBeInTheDocument();
  });

  it('ranks top pods by name with namespace, value and share of the cluster', () => {
    render(<MetricsPage />);
    const row = screen.getByText('kube-apiserver-kind-control-plane').closest('li')!;
    expect(within(row).getByText('kube-system')).toBeInTheDocument();
    expect(within(row).getByText('70m')).toBeInTheDocument();
    expect(within(row).getByText('0.6%')).toBeInTheDocument();
    expect(screen.getByText('Pods measured')).toBeInTheDocument();
  });

  it('gives the usage charts round value ticks', () => {
    render(<MetricsPage />);
    const labels = [...document.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(['100m', '200m', '300m', '512Mi', '1Gi', '1.5Gi', '2Gi']));
  });

  it('offers the install from an empty state when metrics-server is missing', () => {
    fixtures.status = { installed: false, managedByKubus: false, ready: false } as MetricsServerStatus;
    fixtures.summary = { ...fixtures.summary!, available: false };
    render(<MetricsPage />);
    expect(screen.getByText('metrics-server is not installed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install metrics-server' })).toBeInTheDocument();
  });
});
