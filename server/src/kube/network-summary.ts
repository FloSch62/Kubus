import type { ClusterNetworkSummary, NetworkSeriesEntry } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';

const TOP_PODS = 10;
const MAX_LINKS = 200;

/**
 * Everything the Network Metrics page charts in one response, computed from
 * the network poller's in-memory state: cluster-wide throughput series, top
 * pods by sent/received rate, and the busiest links (capped — linkCount
 * carries the uncapped total).
 */
export function computeNetworkSummary(handle: ClusterHandle): ClusterNetworkSummary {
  const poller = handle.networkPoller;
  const links = poller.latestLinks();
  const histories = poller.podHistories();

  const entries: Array<NetworkSeriesEntry & { sentBps: number; recvBps: number }> = [...histories].map(([key, series]) => {
    const slash = key.indexOf('/');
    const latest = series.at(-1);
    return {
      namespace: key.slice(0, slash) || undefined,
      name: key.slice(slash + 1),
      series,
      sentBps: latest?.sentBps ?? 0,
      recvBps: latest?.recvBps ?? 0,
    };
  });
  const strip = ({ name, namespace, series }: NetworkSeriesEntry): NetworkSeriesEntry => ({ name, namespace, series });
  const topPodsSent = [...entries].sort((a, b) => b.sentBps - a.sentBps).slice(0, TOP_PODS).map(strip);
  const topPodsRecv = [...entries].sort((a, b) => b.recvBps - a.recvBps).slice(0, TOP_PODS).map(strip);

  return {
    available: poller.available,
    agentsReady: poller.agentsReporting,
    agentsDesired: poller.agentsListed,
    clusterSeries: poller.clusterHistory(),
    topPodsSent,
    topPodsRecv,
    links: links.slice(0, MAX_LINKS),
    linkCount: links.length,
    podCount: entries.length,
  };
}
