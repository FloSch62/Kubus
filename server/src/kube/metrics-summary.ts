import type { ClusterMetricsSummary, MetricsSample, MetricsSeriesEntry, NamespaceUsage } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { cpuToMilli, memToBytes } from './quantity.js';

const TOP_PODS = 10;

/**
 * Everything the Metrics page charts in one response, computed from the
 * poller's in-memory histories: cluster-wide series, per-node series with
 * capacity, top pods by CPU/memory, and per-namespace usage.
 */
export function computeMetricsSummary(handle: ClusterHandle): ClusterMetricsSummary {
  const poller = handle.metricsPoller;

  // Allocatable capacity per node from the (pinned) nodes watcher.
  const capacity = new Map<string, { cpuMilli?: number; memBytes?: number }>();
  const nodesWatcher = handle.watchers.peek('', 'v1', 'nodes');
  for (const node of nodesWatcher?.items() ?? []) {
    const alloc = (node.status as { allocatable?: { cpu?: string; memory?: string } })?.allocatable;
    if (alloc) {
      capacity.set(node.metadata.name, {
        cpuMilli: alloc.cpu ? cpuToMilli(alloc.cpu) : undefined,
        memBytes: alloc.memory ? memToBytes(alloc.memory) : undefined,
      });
    }
  }

  const nodes: MetricsSeriesEntry[] = [...poller.nodeHistories()]
    .map(([name, series]) => ({
      name,
      series,
      cpuCapacityMilli: capacity.get(name)?.cpuMilli,
      memCapacityBytes: capacity.get(name)?.memBytes,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // All samples of one poll share the same timestamp, so summing by t yields
  // the cluster-wide series directly.
  const byTick = new Map<number, MetricsSample>();
  for (const node of nodes) {
    for (const s of node.series) {
      const acc = byTick.get(s.t);
      if (acc) {
        acc.cpuMilli += s.cpuMilli;
        acc.memBytes += s.memBytes;
      } else {
        byTick.set(s.t, { ...s });
      }
    }
  }
  const clusterSeries = [...byTick.values()].sort((a, b) => a.t - b.t);

  const pods = poller.podSnapshot();
  const histories = poller.podHistories();
  const podEntry = (p: { name: string; namespace?: string }): MetricsSeriesEntry => ({
    name: p.name,
    namespace: p.namespace,
    series: histories.get(`${p.namespace ?? ''}/${p.name}`) ?? [],
  });
  const topPodsCpu = [...pods].sort((a, b) => b.cpuMilli - a.cpuMilli).slice(0, TOP_PODS).map(podEntry);
  const topPodsMem = [...pods].sort((a, b) => b.memBytes - a.memBytes).slice(0, TOP_PODS).map(podEntry);

  const byNamespace = new Map<string, NamespaceUsage>();
  for (const p of pods) {
    const ns = p.namespace ?? '';
    const acc = byNamespace.get(ns) ?? { namespace: ns, cpuMilli: 0, memBytes: 0, pods: 0 };
    acc.cpuMilli += p.cpuMilli;
    acc.memBytes += p.memBytes;
    acc.pods += 1;
    byNamespace.set(ns, acc);
  }
  const namespaces = [...byNamespace.values()].sort((a, b) => b.cpuMilli - a.cpuMilli);

  const totalCpuCapacity = nodes.reduce((sum, n) => sum + (n.cpuCapacityMilli ?? 0), 0);
  const totalMemCapacity = nodes.reduce((sum, n) => sum + (n.memCapacityBytes ?? 0), 0);

  return {
    available: poller.available,
    clusterSeries,
    cpuCapacityMilli: totalCpuCapacity || undefined,
    memCapacityBytes: totalMemCapacity || undefined,
    nodes,
    topPodsCpu,
    topPodsMem,
    namespaces,
    podCount: pods.length,
  };
}
