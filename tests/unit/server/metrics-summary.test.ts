import { describe, expect, it } from 'vitest';
import type { MetricsSample, MetricsSnapshotEntry } from '@kubus/shared';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { computeMetricsSummary } from '../../../server/src/kube/metrics-summary.js';

function sample(t: number, cpuMilli: number, memBytes: number): MetricsSample {
  return { t, cpuMilli, memBytes };
}

interface NodeSpec {
  name: string;
  allocatable?: { cpu?: string; memory?: string };
}

function fakeHandle(opts: {
  available?: boolean;
  nodeHistories?: Map<string, MetricsSample[]>;
  pods?: MetricsSnapshotEntry[];
  podHistories?: Map<string, MetricsSample[]>;
  /** Omit entirely to simulate a missing nodes watcher. */
  nodeObjects?: NodeSpec[];
}): ClusterHandle {
  const poller = {
    available: opts.available ?? true,
    nodeHistories: () => opts.nodeHistories ?? new Map<string, MetricsSample[]>(),
    podSnapshot: () => opts.pods ?? [],
    podHistories: () => opts.podHistories ?? new Map<string, MetricsSample[]>(),
  };
  const watchers = {
    peek: (group: string, version: string, plural: string) => {
      if (!opts.nodeObjects || group !== '' || version !== 'v1' || plural !== 'nodes') return undefined;
      return {
        items: () =>
          opts.nodeObjects?.map((n) => ({
            metadata: { name: n.name, uid: `uid-${n.name}` },
            status: n.allocatable ? { allocatable: n.allocatable } : {},
          })),
      };
    },
  };
  return { metricsPoller: poller, watchers } as unknown as ClusterHandle;
}

describe('computeMetricsSummary', () => {
  it('attaches allocatable capacity per node, sorts by name, and totals it', () => {
    const handle = fakeHandle({
      nodeHistories: new Map([
        ['node-b', [sample(1, 200, 2048)]],
        ['node-a', [sample(1, 100, 1024)]],
      ]),
      nodeObjects: [
        { name: 'node-a', allocatable: { cpu: '2', memory: '1Gi' } },
        { name: 'node-b', allocatable: { cpu: '500m', memory: '512Mi' } },
      ],
    });

    const summary = computeMetricsSummary(handle);

    expect(summary.nodes.map((n) => n.name)).toEqual(['node-a', 'node-b']);
    expect(summary.nodes[0]?.cpuCapacityMilli).toBe(2000);
    expect(summary.nodes[0]?.memCapacityBytes).toBe(2 ** 30);
    expect(summary.nodes[1]?.cpuCapacityMilli).toBe(500);
    expect(summary.nodes[1]?.memCapacityBytes).toBe(512 * 2 ** 20);
    expect(summary.cpuCapacityMilli).toBe(2500);
    expect(summary.memCapacityBytes).toBe(2 ** 30 + 512 * 2 ** 20);
  });

  it('leaves capacity undefined when the nodes watcher is absent or a node lacks allocatable', () => {
    const noWatcher = computeMetricsSummary(fakeHandle({ nodeHistories: new Map([['node-a', [sample(1, 1, 1)]]]) }));
    expect(noWatcher.nodes).toHaveLength(1);
    expect(noWatcher.nodes[0]?.cpuCapacityMilli).toBeUndefined();
    expect(noWatcher.cpuCapacityMilli).toBeUndefined();
    expect(noWatcher.memCapacityBytes).toBeUndefined();

    const noAllocatable = computeMetricsSummary(
      fakeHandle({
        nodeHistories: new Map([['node-a', [sample(1, 1, 1)]]]),
        nodeObjects: [{ name: 'node-a' }],
      }),
    );
    expect(noAllocatable.nodes).toHaveLength(1);
    expect(noAllocatable.nodes[0]?.cpuCapacityMilli).toBeUndefined();
  });

  it('sums node samples per tick into a time-sorted cluster series', () => {
    const handle = fakeHandle({
      nodeHistories: new Map([
        ['node-a', [sample(1000, 100, 1000), sample(2000, 200, 2000)]],
        ['node-b', [sample(1000, 50, 500), sample(3000, 10, 10)]],
      ]),
    });

    const summary = computeMetricsSummary(handle);

    expect(summary.clusterSeries).toEqual([sample(1000, 150, 1500), sample(2000, 200, 2000), sample(3000, 10, 10)]);
  });

  it('ranks top pods by cpu and memory independently and attaches their histories', () => {
    const pods: MetricsSnapshotEntry[] = [];
    for (let i = 1; i <= 12; i++) {
      const name = `pod-${String(i).padStart(2, '0')}`;
      pods.push({ name, namespace: 'ns-a', cpuMilli: i * 10, memBytes: (13 - i) * 10 });
    }
    const history = [sample(1, 120, 10)];
    const handle = fakeHandle({ pods, podHistories: new Map([['ns-a/pod-12', history]]) });

    const summary = computeMetricsSummary(handle);

    expect(summary.topPodsCpu).toHaveLength(10);
    expect(summary.topPodsCpu.map((p) => p.name)).toEqual(
      ['pod-12', 'pod-11', 'pod-10', 'pod-09', 'pod-08', 'pod-07', 'pod-06', 'pod-05', 'pod-04', 'pod-03'],
    );
    expect(summary.topPodsMem.map((p) => p.name)).toEqual(
      ['pod-01', 'pod-02', 'pod-03', 'pod-04', 'pod-05', 'pod-06', 'pod-07', 'pod-08', 'pod-09', 'pod-10'],
    );
    expect(summary.topPodsCpu[0]?.series).toEqual(history);
    expect(summary.topPodsCpu[1]?.series).toEqual([]);
    expect(summary.podCount).toBe(12);
  });

  it('aggregates namespace usage sorted by cpu, grouping namespace-less pods under empty string', () => {
    const handle = fakeHandle({
      pods: [
        { name: 'a1', namespace: 'alpha', cpuMilli: 100, memBytes: 10 },
        { name: 'a2', namespace: 'alpha', cpuMilli: 50, memBytes: 20 },
        { name: 'b1', namespace: 'beta', cpuMilli: 200, memBytes: 5 },
        { name: 'stray', cpuMilli: 1, memBytes: 1 },
      ],
    });

    const summary = computeMetricsSummary(handle);

    expect(summary.namespaces).toEqual([
      { namespace: 'beta', cpuMilli: 200, memBytes: 5, pods: 1 },
      { namespace: 'alpha', cpuMilli: 150, memBytes: 30, pods: 2 },
      { namespace: '', cpuMilli: 1, memBytes: 1, pods: 1 },
    ]);
  });

  it('passes through poller availability and handles an empty poller', () => {
    const summary = computeMetricsSummary(fakeHandle({ available: false }));

    expect(summary.available).toBe(false);
    expect(summary.clusterSeries).toEqual([]);
    expect(summary.nodes).toEqual([]);
    expect(summary.topPodsCpu).toEqual([]);
    expect(summary.namespaces).toEqual([]);
    expect(summary.podCount).toBe(0);
  });
});
