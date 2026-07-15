import type { FastifyBaseLogger } from 'fastify';
import type { NetworkLink, NetworkPeer, NetworkSample, NetworkThroughputSample } from '@kubus/shared';
import type { RawClient } from './raw-client.js';
import type { ResourceWatcher, WatcherRegistry } from './watcher.js';
import { parsePrometheusText } from '../util/prometheus.js';
import { NETWORK_AGENT_NAMESPACE, NETWORK_AGENT_PORT, NETWORK_AGENT_SELECTOR, applyMetricsConfiguration } from './network-agent.js';
import type { ClusterHandle } from './cluster-manager.js';

const POLL_MS = 20_000;
const UNAVAILABLE_POLL_MS = 60_000;
const RING_CAPACITY = 90; // ~30 min at 20s
const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * The Retina adv_ families we consume; everything else is skipped at parse
 * time. Retransmit/drop series only exist once such events occur (both
 * spellings kept — docs and source disagree on the retransmit name).
 */
const FORWARD_FAMILY = 'networkobservability_adv_forward_bytes';
const DROP_FAMILY = 'networkobservability_adv_drop_bytes';
const RETRANS_FAMILIES = ['networkobservability_adv_tcp_retransmission_count', 'networkobservability_adv_tcpretrans_count'];
const FAMILIES = new Set([FORWARD_FAMILY, DROP_FAMILY, ...RETRANS_FAMILIES]);

/** One endpoint of an observed flow, before display resolution. */
interface RawPeer {
  /** Stable identity: `pod/<ns>/<name>` for real pods, `ip/<ip>` otherwise. */
  key: string;
  ip: string;
  namespace?: string;
  podname?: string;
}

/** Cumulative counters for one unordered endpoint pair. */
interface PairCounters {
  a: RawPeer;
  b: RawPeer;
  /** bytes a→b / b→a (cumulative) */
  ab: number;
  ba: number;
  retrans: number;
  drop: number;
}

interface AgentPod {
  name: string;
  ready: boolean;
}

/**
 * Polls the Retina agent DaemonSet pods through the API-server pod proxy,
 * turning their cumulative pod-level flow counters (adv_forward_bytes etc.)
 * into per-second link rates and short in-memory histories. Rates need two
 * scrapes, so charts fill one poll after install. Also keeps the Retina
 * MetricsConfiguration's namespace include-list in sync with the cluster
 * (Retina has no wildcard — new namespaces would silently go unobserved).
 * Degrades gracefully when the agent is absent (probes at a slower interval).
 */
export class NetworkMetricsPoller {
  available = false;
  /** Agent pods scraped successfully / listed, from the last poll. */
  agentsReporting = 0;
  agentsListed = 0;

  private links: NetworkLink[] = [];
  private prevCounters = new Map<string, PairCounters>();
  private prevT = 0;
  private pods = new Map<string, NetworkSample[]>(); // key: ns/name
  private cluster: NetworkThroughputSample[] = [];
  private appliedNamespaces = '';
  private services?: { watcher: ResourceWatcher; release: () => void };
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;
  private lastPollStart = 0;
  /** Bumped by markUnavailable() so an in-flight poll can't overwrite the reset. */
  private epoch = 0;
  /** Set after construction by ClusterHandle (mutual reference). */
  handle?: ClusterHandle;

  constructor(
    private raw: RawClient,
    private watchers: WatcherRegistry,
    private log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.services?.release();
    this.services = undefined;
  }

  latestLinks(): NetworkLink[] {
    return this.links;
  }

  /** Keys are `namespace/name`. */
  podHistories(): ReadonlyMap<string, NetworkSample[]> {
    return this.pods;
  }

  clusterHistory(): NetworkThroughputSample[] {
    return this.cluster;
  }

  /**
   * Poll soon instead of waiting out the (slow) unavailable interval — used
   * right after installing/uninstalling the agent. Throttled so status
   * probes can call it freely.
   */
  kick(): void {
    if (this.stopped || this.polling || Date.now() - this.lastPollStart < 5_000) return;
    if (this.timer) clearTimeout(this.timer);
    void this.poll();
  }

  /**
   * Drop to unavailable right now — the agent was just uninstalled, and its
   * pods linger while terminating, so waiting for the next poll to fail
   * would keep serving stale traffic for up to a poll interval.
   */
  markUnavailable(): void {
    this.epoch++;
    this.available = false;
    this.agentsReporting = 0;
    this.agentsListed = 0;
    this.links = [];
    this.prevCounters.clear();
    this.prevT = 0;
    this.appliedNamespaces = '';
    // Also drop the histories: after a reinstall the first tick has no rates
    // yet (dtSec 0 short-circuits ingest), so anything left here would be
    // served as if it were current.
    this.cluster = [];
    this.pods.clear();
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
      const agents = await this.listAgentPods();
      const ready = agents.filter((a) => a.ready);
      if (!ready.length) throw new Error('no ready retina-agent pods');

      const scrapes = await Promise.allSettled(ready.map((a) => this.scrape(a.name)));
      if (epoch !== this.epoch) return; // reset while in flight — discard this round
      const bodies = scrapes.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value);
      if (!bodies.length) {
        const first = scrapes.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        throw first?.reason ?? new Error('all agent scrapes failed');
      }

      const t = Date.now();
      this.ingest(collectCounters(bodies), t);
      this.agentsReporting = bodies.length;
      this.agentsListed = agents.length;
      if (!this.available) this.acquireServicesWatcher();
      this.available = true;
      await this.reconcileMetricsConfiguration();
    } catch (err) {
      if (epoch === this.epoch) {
        if (this.available) this.log.info({ err: String(err) }, 'network metrics became unavailable');
        this.available = false;
        this.agentsReporting = 0;
        this.agentsListed = 0;
        this.links = [];
        this.prevCounters.clear();
        this.prevT = 0;
        this.appliedNamespaces = '';
      }
    } finally {
      this.polling = false;
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), this.available ? POLL_MS : UNAVAILABLE_POLL_MS);
    this.timer.unref();
  }

  /**
   * Keep the MetricsConfiguration's explicit namespace list in step with the
   * cluster. Best-effort — a failed apply retries on the next poll.
   */
  private async reconcileMetricsConfiguration(): Promise<void> {
    if (!this.handle) return;
    const namespaces = (this.watchers.peek('', 'v1', 'namespaces')?.items() ?? []).map((ns) => ns.metadata.name).sort();
    if (!namespaces.length) return;
    const fingerprint = namespaces.join(',');
    if (fingerprint === this.appliedNamespaces) return;
    try {
      await applyMetricsConfiguration(this.handle, namespaces);
      this.appliedNamespaces = fingerprint;
    } catch (err) {
      this.log.warn({ err: String(err) }, 'network metrics: MetricsConfiguration apply failed');
    }
  }

  private async listAgentPods(): Promise<AgentPod[]> {
    interface PodList {
      items?: Array<{
        metadata?: { name?: string };
        status?: { phase?: string; conditions?: Array<{ type?: string; status?: string }> };
      }>;
    }
    const query = new URLSearchParams({ labelSelector: NETWORK_AGENT_SELECTOR });
    const list = await this.raw.json<PodList>(`/api/v1/namespaces/${NETWORK_AGENT_NAMESPACE}/pods?${query.toString()}`);
    return (list.items ?? [])
      .filter((p) => p.metadata?.name)
      .map((p) => ({
        name: p.metadata!.name!,
        ready: p.status?.phase === 'Running' && (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      }));
  }

  /** Fetch one agent's Prometheus exposition through the API-server pod proxy. */
  private async scrape(pod: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
    timeout.unref();
    try {
      const path = `/api/v1/namespaces/${NETWORK_AGENT_NAMESPACE}/pods/${encodeURIComponent(pod)}:${NETWORK_AGENT_PORT}/proxy/metrics`;
      const res = await this.raw.request(path, { signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`scrape of ${pod} failed: ${res.status} ${res.statusText}`);
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Turn this tick's cumulative counters into rates against the previous tick. */
  private ingest(counters: Map<string, PairCounters>, t: number): void {
    const dtSec = this.prevT ? (t - this.prevT) / 1000 : 0;
    const resolve = this.buildResolver();

    const links: NetworkLink[] = [];
    let totalBps = 0;
    const podRates = new Map<string, { sent: number; recv: number }>();
    const bump = (peer: NetworkPeer, sent: number, recv: number) => {
      if (peer.kind !== 'pod') return;
      const key = `${peer.namespace ?? ''}/${peer.name}`;
      const acc = podRates.get(key) ?? { sent: 0, recv: 0 };
      acc.sent += sent;
      acc.recv += recv;
      podRates.set(key, acc);
    };
    // A counter that shrank means the agent restarted — treat this tick as a
    // fresh baseline for that pair instead of charting a bogus rate.
    const rate = (cur: number, prev: number | undefined) => (dtSec > 0 && prev !== undefined && cur >= prev ? (cur - prev) / dtSec : 0);

    for (const [key, cur] of counters) {
      const prev = this.prevCounters.get(key);
      const abBps = rate(cur.ab, prev?.ab);
      const baBps = rate(cur.ba, prev?.ba);
      const retransmitsPerSec = rate(cur.retrans, prev?.retrans);
      const droppedBps = rate(cur.drop, prev?.drop);
      if (abBps === 0 && baBps === 0 && retransmitsPerSec === 0 && droppedBps === 0) continue;

      const a = resolve(cur.a);
      const b = resolve(cur.b);
      links.push({ a, b, abBps, baBps, retransmitsPerSec, droppedBps });
      totalBps += abBps + baBps;
      bump(a, abBps, baBps);
      bump(b, baBps, abBps);
    }

    this.links = links.sort((x, y) => y.abBps + y.baBps - (x.abBps + x.baBps));
    this.prevCounters = counters;
    this.prevT = t;

    // Rates need two scrapes — don't chart the all-zero first tick.
    if (dtSec <= 0) return;
    push(this.cluster, { t, bps: totalBps });
    const live = new Set<string>();
    for (const [key, rates] of podRates) {
      live.add(key);
      let ring = this.pods.get(key);
      if (!ring) this.pods.set(key, (ring = []));
      push(ring, { t, sentBps: rates.sent, recvBps: rates.recv });
    }
    for (const key of this.pods.keys()) {
      if (!live.has(key)) this.pods.delete(key);
    }
  }

  /**
   * Display resolution for non-pod endpoints, from the warm watcher caches:
   * Service ClusterIPs (Retina reports the apiserver as a pseudo-pod, and
   * unresolved IPs as "unknown"), then node IPs, else external.
   */
  private buildResolver(): (raw: RawPeer) => NetworkPeer {
    const nodesByIp = new Map<string, string>();
    for (const node of this.watchers.peek('', 'v1', 'nodes')?.items() ?? []) {
      const status = node.status as { addresses?: Array<{ type?: string; address?: string }> } | undefined;
      for (const addr of status?.addresses ?? []) {
        if ((addr.type === 'InternalIP' || addr.type === 'ExternalIP') && addr.address) nodesByIp.set(addr.address, node.metadata.name);
      }
    }
    const servicesByIp = new Map<string, { namespace: string; name: string }>();
    for (const svc of this.services?.watcher.items() ?? []) {
      const spec = svc.spec as { clusterIP?: string; clusterIPs?: string[] } | undefined;
      for (const ip of spec?.clusterIPs ?? [spec?.clusterIP]) {
        if (ip && ip !== 'None') servicesByIp.set(ip, { namespace: svc.metadata.namespace ?? '', name: svc.metadata.name });
      }
    }
    return (raw) => {
      if (raw.podname && raw.namespace) return { kind: 'pod', namespace: raw.namespace, name: raw.podname };
      const svc = servicesByIp.get(raw.ip);
      if (svc) return { kind: 'service', namespace: svc.namespace, name: svc.name };
      const node = nodesByIp.get(raw.ip);
      if (node) return { kind: 'node', name: node };
      return { kind: 'external', name: raw.ip };
    };
  }

  /** Services aren't pinned by the overview — hold a watcher only while traffic data flows. */
  private acquireServicesWatcher(): void {
    if (this.services || this.stopped) return;
    this.services = this.watchers.acquire('', 'v1', 'services');
    void this.services.watcher.ready().catch(() => {
      /* resolver degrades to external until the list succeeds */
    });
  }
}

/**
 * Aggregate the agents' exposition bodies into cumulative per-pair counters.
 * The same flow can be exported from both its endpoints' nodes (and as both
 * INGRESS and EGRESS on one node), so per src→dst direction the MAX across
 * all series is taken — summing would double-count. Drop series additionally
 * carry a reason label: maxima are kept per reason, then summed, so links
 * dropping for several reasons aren't underreported.
 */
function collectCounters(bodies: string[]): Map<string, PairCounters> {
  // Directed maxima per `${srcKey}>${dstKey}` per family.
  const directed = new Map<string, { src: RawPeer; dst: RawPeer; forward: number; retrans: number; drops: Map<string, number> }>();
  for (const body of bodies) {
    for (const sample of parsePrometheusText(body, FAMILIES)) {
      const src = peerOf(sample.labels, 'source');
      const dst = peerOf(sample.labels, 'destination');
      if (!src || !dst || src.key === dst.key) continue;
      const key = `${src.key}>${dst.key}`;
      let acc = directed.get(key);
      if (!acc) {
        acc = { src, dst, forward: 0, retrans: 0, drops: new Map() };
        directed.set(key, acc);
      }
      if (sample.name === FORWARD_FAMILY) {
        acc.forward = Math.max(acc.forward, sample.value);
      } else if (sample.name === DROP_FAMILY) {
        const reason = sample.labels.reason ?? '';
        acc.drops.set(reason, Math.max(acc.drops.get(reason) ?? 0, sample.value));
      } else {
        acc.retrans = Math.max(acc.retrans, sample.value);
      }
    }
  }

  // Fold the two directions into one unordered pair record.
  const pairs = new Map<string, PairCounters>();
  for (const { src, dst, forward, retrans, drops } of directed.values()) {
    const ordered = src.key <= dst.key;
    const [a, b] = ordered ? [src, dst] : [dst, src];
    const key = `${a.key}|${b.key}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { a, b, ab: 0, ba: 0, retrans: 0, drop: 0 };
      pairs.set(key, pair);
    }
    if (ordered) pair.ab += forward;
    else pair.ba += forward;
    pair.retrans += retrans;
    for (const value of drops.values()) pair.drop += value;
  }
  return pairs;
}

/** Retina labels unresolved peers "unknown" and the apiserver as a pseudo-pod — treat both as IP-only. */
function peerOf(labels: Record<string, string>, side: 'source' | 'destination'): RawPeer | undefined {
  const ip = labels[`${side}_ip`];
  if (!ip) return undefined;
  const namespace = labels[`${side}_namespace`];
  const podname = labels[`${side}_podname`];
  const realPod = !!namespace && !!podname && podname !== 'unknown' && namespace !== 'unknown' && namespace !== 'kubernetes-apiserver';
  return realPod ? { key: `pod/${namespace}/${podname}`, ip, namespace, podname } : { key: `ip/${ip}`, ip };
}

function push<T>(ring: T[], sample: T): void {
  ring.push(sample);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
}
