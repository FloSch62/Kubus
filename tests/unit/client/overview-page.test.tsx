import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterOverview, MetricsSnapshot } from '@kubus/shared';
import { OverviewPage } from '../../../client/src/pages/OverviewPage';
import { useClustersStore } from '../../../client/src/state/clusters';

const fixtures = vi.hoisted(() => ({
  overview: undefined as ClusterOverview | undefined,
  nodeMetrics: undefined as MetricsSnapshot | undefined,
}));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResources: () => ({ data: [] }),
  useContexts: () => ({ data: [] }),
  useKubeconfigSettings: () => ({ data: undefined }),
  useNodeMetrics: () => ({ data: fixtures.nodeMetrics }),
  useOverview: () => ({ data: fixtures.overview, isLoading: false, error: null }),
  useOverviewCertificates: () => ({ data: undefined }),
  useOverviewOperators: () => ({ data: undefined }),
}));

vi.mock('../../../client/src/components/ClusterSectionHeader.js', () => ({
  ClusterSectionHeader: ({ ctx }: { ctx: string }) => <h2>{ctx}</h2>,
}));
vi.mock('../../../client/src/components/overview/CertExpiryCard.js', () => ({ CertExpiryCard: () => null }));
vi.mock('../../../client/src/components/overview/NamespaceOverviewSection.js', () => ({ NamespaceOverviewSection: () => null }));
vi.mock('../../../client/src/components/overview/OperatorSection.js', () => ({ OperatorSection: () => null }));
vi.mock('../../../client/src/components/overview/PodUsagePanels.js', () => ({ PodUsagePanels: () => null }));
vi.mock('../../../client/src/components/overview/WorkloadHealthSection.js', () => ({ WorkloadHealthSection: () => null }));

beforeEach(() => {
  useClustersStore.setState({ selected: ['dev'], namespaces: [] });
  fixtures.overview = {
    counts: {
      nodes: 1,
      namespaces: 1,
      pods: 0,
      podsRunning: 0,
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
  fixtures.nodeMetrics = {
    available: true,
    probed: true,
    totalCpuCapacityMilli: 6_000,
    totalMemCapacityBytes: 16 * 2 ** 30,
    items: [
      {
        name: 'node-a',
        cpuMilli: 500,
        memBytes: 2 * 2 ** 30,
        cpuCapacityMilli: 2_000,
        memCapacityBytes: 8 * 2 ** 30,
      },
    ],
  };
});

describe('OverviewPage node usage', () => {
  it('shows CPU and memory capacity for each node', () => {
    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('node-a')).toBeInTheDocument();
    expect(screen.getByText('CPU 500m / 2.00 cores (25%)')).toBeInTheDocument();
    expect(screen.getByText('Mem 2.0Gi / 8.0Gi (25%)')).toBeInTheDocument();
  });
});
