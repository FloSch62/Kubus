import type { FastifyBaseLogger } from 'fastify';
import { Metrics } from '@kubernetes/client-node';
import type { MetricsSample, MetricsSnapshotEntry } from '@kubus/shared';
import { cpuToMilli, memToBytes } from './quantity.js';

const POLL_MS = 20_000;
const UNAVAILABLE_POLL_MS = 60_000;
const RING_CAPACITY = 90; // ~30 min at 20s

/**
 * Polls metrics.k8s.io for node and pod usage, keeping short in-memory
 * histories for sparklines. Degrades gracefully when metrics-server is
 * absent (probes at a slower interval).
 */
export class MetricsPoller {
  available = false;
  private nodes = new Map<string, MetricsSample[]>();
  private pods = new Map<string, MetricsSample[]>(); // key: ns/name
  private latestNodes: MetricsSnapshotEntry[] = [];
  private latestPods: MetricsSnapshotEntry[] = [];
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;
  private lastPollStart = 0;
  /** Bumped by markUnavailable() so an in-flight poll can't overwrite the reset. */
  private epoch = 0;

  constructor(
    private metrics: Metrics,
    private log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  nodeSnapshot(): MetricsSnapshotEntry[] {
    return this.latestNodes;
  }

  podSnapshot(namespace?: string): MetricsSnapshotEntry[] {
    return namespace ? this.latestPods.filter((p) => p.namespace === namespace) : this.latestPods;
  }

  history(kind: 'node' | 'pod', name: string, namespace?: string): MetricsSample[] {
    return (kind === 'node' ? this.nodes.get(name) : this.pods.get(`${namespace ?? ''}/${name}`)) ?? [];
  }

  nodeHistories(): ReadonlyMap<string, MetricsSample[]> {
    return this.nodes;
  }

  /** Keys are `namespace/name`. */
  podHistories(): ReadonlyMap<string, MetricsSample[]> {
    return this.pods;
  }

  /**
   * Poll soon instead of waiting out the (slow) unavailable interval — used
   * right after installing/uninstalling metrics-server. Throttled so status
   * probes can call it freely.
   */
  kick(): void {
    if (this.stopped || this.polling || Date.now() - this.lastPollStart < 5_000) return;
    if (this.timer) clearTimeout(this.timer);
    void this.poll();
  }

  /**
   * Drop to unavailable right now — metrics-server was just uninstalled, and
   * waiting for the next poll to fail would keep serving stale usage for up
   * to a poll interval. The regular (slow) probe cadence resumes after, so a
   * failed uninstall self-corrects on the next successful poll.
   */
  markUnavailable(): void {
    this.epoch++;
    this.available = false;
    this.latestNodes = [];
    this.latestPods = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), UNAVAILABLE_POLL_MS);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    this.lastPollStart = Date.now();
    const epoch = this.epoch;
    try {
      const t = Date.now();
      const [nodeList, podList] = await Promise.all([this.metrics.getNodeMetrics(), this.metrics.getPodMetrics()]);
      if (epoch !== this.epoch) return; // reset while in flight — discard this round
      this.available = true;

      this.latestNodes = nodeList.items.map((n) => ({
        name: n.metadata.name,
        cpuMilli: cpuToMilli(n.usage.cpu),
        memBytes: memToBytes(n.usage.memory),
      }));
      const liveNodes = new Set<string>();
      for (const entry of this.latestNodes) {
        liveNodes.add(entry.name);
        push(this.nodes, entry.name, { t, cpuMilli: entry.cpuMilli, memBytes: entry.memBytes });
      }
      prune(this.nodes, liveNodes);

      this.latestPods = podList.items.map((p) => {
        let cpuMilli = 0;
        let memBytes = 0;
        for (const c of p.containers) {
          cpuMilli += cpuToMilli(c.usage.cpu);
          memBytes += memToBytes(c.usage.memory);
        }
        return { name: p.metadata.name, namespace: p.metadata.namespace, cpuMilli, memBytes };
      });
      const livePods = new Set<string>();
      for (const entry of this.latestPods) {
        const key = `${entry.namespace ?? ''}/${entry.name}`;
        livePods.add(key);
        push(this.pods, key, { t, cpuMilli: entry.cpuMilli, memBytes: entry.memBytes });
      }
      prune(this.pods, livePods);
    } catch (err) {
      if (this.available) this.log.info({ err: String(err) }, 'metrics became unavailable');
      this.available = false;
      this.latestNodes = [];
      this.latestPods = [];
    } finally {
      this.polling = false;
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), this.available ? POLL_MS : UNAVAILABLE_POLL_MS);
    this.timer.unref();
  }
}

function push(map: Map<string, MetricsSample[]>, key: string, sample: MetricsSample): void {
  let ring = map.get(key);
  if (!ring) {
    ring = [];
    map.set(key, ring);
  }
  ring.push(sample);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
}

function prune(map: Map<string, MetricsSample[]>, live: Set<string>): void {
  for (const key of map.keys()) {
    if (!live.has(key)) map.delete(key);
  }
}
