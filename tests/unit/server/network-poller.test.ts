import type { FastifyBaseLogger } from 'fastify';
import type { KubeObject, NetworkPeer } from '@kubus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { NetworkMetricsPoller } from '../../../server/src/kube/network-poller';
import type { RawClient } from '../../../server/src/kube/raw-client';
import type { WatcherRegistry } from '../../../server/src/kube/watcher';

interface RawPeer {
  key: string;
  ip: string;
  namespace?: string;
  podname?: string;
}

interface PairCounters {
  a: RawPeer;
  b: RawPeer;
  ab: number;
  ba: number;
  retrans: number;
  drop: number;
}

interface PollerInternals {
  links: unknown[];
  prevCounters: Map<string, PairCounters>;
  prevT: number;
  pods: Map<string, unknown[]>;
  cluster: unknown[];
  appliedNamespaces: string;
  services?: { watcher: FakeWatcher; release: () => void };
  timer?: NodeJS.Timeout;
  stopped: boolean;
  polling: boolean;
  lastPollStart: number;
  epoch: number;
  poll(): Promise<void>;
  reconcileMetricsConfiguration(): Promise<void>;
  listAgentPods(): Promise<Array<{ name: string; ready: boolean }>>;
  scrape(pod: string): Promise<string>;
  ingest(counters: Map<string, PairCounters>, t: number): void;
  buildResolver(): (raw: RawPeer) => NetworkPeer;
  acquireServicesWatcher(): void;
}

interface FakeWatcher {
  items(): KubeObject[];
  ready(): Promise<void>;
}

function kubeObject(name: string, overrides: Record<string, unknown> = {}): KubeObject {
  const metadata = (overrides.metadata ?? {}) as Record<string, unknown>;
  return {
    apiVersion: 'v1',
    kind: 'Unknown',
    ...overrides,
    metadata: { name, uid: `${name}-uid`, ...metadata },
  } as KubeObject;
}

function response(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? 'Unavailable' : 'OK',
    text: async () => text,
  } as unknown as Response;
}

function labels(source: { ip: string; namespace?: string; pod?: string }, destination: { ip: string; namespace?: string; pod?: string }) {
  return [
    `source_ip="${source.ip}"`,
    `source_namespace="${source.namespace ?? 'unknown'}"`,
    `source_podname="${source.pod ?? 'unknown'}"`,
    `destination_ip="${destination.ip}"`,
    `destination_namespace="${destination.namespace ?? 'unknown'}"`,
    `destination_podname="${destination.pod ?? 'unknown'}"`,
  ].join(',');
}

function metrics(multiplier: number): string {
  const web = { ip: '10.0.0.10', namespace: 'apps', pod: 'web-0' };
  const service = { ip: '10.96.0.20' };
  const node = { ip: '192.168.1.10' };
  const external = { ip: '8.8.8.8' };
  return [
    `networkobservability_adv_forward_bytes{${labels(web, service)}} ${1000 * multiplier}`,
    `networkobservability_adv_forward_bytes{${labels(web, service)},direction="EGRESS"} ${900 * multiplier}`,
    `networkobservability_adv_forward_bytes{${labels(service, web)}} ${400 * multiplier}`,
    `networkobservability_adv_tcp_retransmission_count{${labels(web, service)}} ${3 * multiplier}`,
    `networkobservability_adv_tcpretrans_count{${labels(service, web)}} ${2 * multiplier}`,
    `networkobservability_adv_drop_bytes{${labels(web, service)},reason="policy"} ${10 * multiplier}`,
    `networkobservability_adv_drop_bytes{${labels(web, service)},reason="queue"} ${5 * multiplier}`,
    `networkobservability_adv_forward_bytes{${labels(node, web)}} ${250 * multiplier}`,
    `networkobservability_adv_forward_bytes{${labels(external, web)}} ${125 * multiplier}`,
    `networkobservability_adv_forward_bytes{${labels(web, web)}} ${9999 * multiplier}`,
    'networkobservability_adv_forward_bytes{source_ip="10.0.0.1"} 42',
    'unrelated_metric 999',
  ].join('\n');
}

function createHarness(options: {
  pods?: unknown[];
  request?: (path: string) => Promise<Response>;
  namespaceItems?: KubeObject[];
  nodeItems?: KubeObject[];
  serviceItems?: KubeObject[];
  serviceReadyRejects?: boolean;
} = {}) {
  const namespaceItems = options.namespaceItems ?? [kubeObject('zeta'), kubeObject('alpha')];
  const nodeItems =
    options.nodeItems ??
    [
      kubeObject('worker-1', {
        kind: 'Node',
        status: { addresses: [{ type: 'InternalIP', address: '192.168.1.10' }, { type: 'Hostname', address: 'worker-1' }] },
      }),
    ];
  const serviceItems =
    options.serviceItems ??
    [
      kubeObject('api', {
        kind: 'Service',
        metadata: { name: 'api', namespace: 'apps' },
        spec: { clusterIP: '10.96.0.20', clusterIPs: ['10.96.0.20', 'None'] },
      }),
    ];
  const serviceWatcher: FakeWatcher = {
    items: () => serviceItems,
    ready: options.serviceReadyRejects ? async () => Promise.reject(new Error('watch denied')) : async () => {},
  };
  const release = vi.fn();
  const watchers = {
    peek: vi.fn((_group: string, _version: string, plural: string) => {
      if (plural === 'namespaces') return { items: () => namespaceItems };
      if (plural === 'nodes') return { items: () => nodeItems };
      return undefined;
    }),
    acquire: vi.fn(() => ({ watcher: serviceWatcher, release })),
  } as unknown as WatcherRegistry;
  const raw = {
    json: vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.includes('/pods?')) {
        return {
          items:
            options.pods ??
            [
              {
                metadata: { name: 'retina-a' },
                status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
              },
              {
                metadata: { name: 'retina-b' },
                status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
              },
              { metadata: { name: 'retina-pending' }, status: { phase: 'Pending' } },
              { metadata: {}, status: { phase: 'Running' } },
            ],
        };
      }
      if (init?.method === 'PATCH') return {};
      throw new Error(`unexpected JSON request: ${path}`);
    }),
    request: vi.fn(options.request ?? (async () => response(metrics(1)))),
  } as unknown as RawClient;
  const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
  const poller = new NetworkMetricsPoller(raw, watchers, log);
  poller.handle = { raw, watchers } as unknown as ClusterHandle;
  return {
    poller,
    internals: poller as unknown as PollerInternals,
    raw: raw as unknown as { json: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> },
    watchers: watchers as unknown as { peek: ReturnType<typeof vi.fn>; acquire: ReturnType<typeof vi.fn> },
    log: log as unknown as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> },
    release,
  };
}

describe('NetworkMetricsPoller successful polling', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scrapes ready agents, aggregates directional maxima, resolves peers, and builds histories', async () => {
    let round = 1;
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const harness = createHarness({
      request: async () => response(metrics(round)),
      serviceReadyRejects: true,
    });

    await harness.internals.poll();
    expect(harness.poller.available).toBe(true);
    expect(harness.poller.agentsReporting).toBe(2);
    expect(harness.poller.agentsListed).toBe(3);
    expect(harness.poller.latestLinks()).toEqual([]);
    expect(harness.poller.clusterHistory()).toEqual([]);
    expect(harness.watchers.acquire).toHaveBeenCalledWith('', 'v1', 'services');
    expect(harness.raw.json).toHaveBeenCalledWith(
      expect.stringContaining('/metricsconfigurations/kubus-network-metrics?fieldManager=kubus&force=true'),
      expect.objectContaining({ method: 'PATCH' }),
    );
    const patchCallCount = harness.raw.json.mock.calls.filter(([, init]) => init?.method === 'PATCH').length;

    round = 2;
    now = 3_000;
    await harness.internals.poll();
    const links = harness.poller.latestLinks();
    expect(links.length).toBe(3);
    expect(links).toContainEqual(
      expect.objectContaining({
        a: { kind: 'service', namespace: 'apps', name: 'api' },
        b: { kind: 'pod', namespace: 'apps', name: 'web-0' },
        abBps: 200,
        baBps: 500,
        retransmitsPerSec: 2.5,
        droppedBps: 7.5,
      }),
    );
    expect(links).toContainEqual(expect.objectContaining({ a: { kind: 'node', name: 'worker-1' }, b: { kind: 'pod', namespace: 'apps', name: 'web-0' } }));
    expect(links).toContainEqual(expect.objectContaining({ a: { kind: 'external', name: '8.8.8.8' }, b: { kind: 'pod', namespace: 'apps', name: 'web-0' } }));
    expect(harness.poller.clusterHistory()).toEqual([{ t: 3000, bps: 887.5 }]);
    expect(harness.poller.podHistories().get('apps/web-0')).toEqual([
      expect.objectContaining({ t: 3000, sentBps: 500, recvBps: 387.5 }),
    ]);
    expect(harness.raw.json.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(patchCallCount);

    harness.poller.stop();
    expect(harness.release).toHaveBeenCalled();
    expect(harness.poller.latestLinks()).toBe(links);
  });

  it('reconciles namespace configuration only when it changes and retries failed applies', async () => {
    const harness = createHarness();
    await harness.internals.reconcileMetricsConfiguration();
    expect(harness.internals.appliedNamespaces).toBe('alpha,zeta');
    await harness.internals.reconcileMetricsConfiguration();
    expect(harness.raw.json.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);

    harness.internals.appliedNamespaces = '';
    harness.raw.json.mockRejectedValueOnce(new Error('CRD unavailable'));
    await harness.internals.reconcileMetricsConfiguration();
    expect(harness.internals.appliedNamespaces).toBe('');
    expect(harness.log.warn).toHaveBeenCalledWith(expect.anything(), 'network metrics: MetricsConfiguration apply failed');

    harness.poller.handle = undefined;
    await harness.internals.reconcileMetricsConfiguration();
    harness.poller.handle = { raw: harness.raw } as unknown as ClusterHandle;
    const empty = createHarness({ namespaceItems: [] });
    await empty.internals.reconcileMetricsConfiguration();
    expect(empty.internals.appliedNamespaces).toBe('');
  });

  it('keeps rings bounded and drops histories for peers that disappear', () => {
    const harness = createHarness();
    const pod: RawPeer = { key: 'pod/apps/web', ip: '10.0.0.1', namespace: 'apps', podname: 'web' };
    const outside: RawPeer = { key: 'ip/8.8.8.8', ip: '8.8.8.8' };
    const counters = (value: number) =>
      new Map<string, PairCounters>([['pair', { a: pod, b: outside, ab: value, ba: value / 2, retrans: value / 10, drop: value / 20 }]]);

    harness.internals.ingest(counters(100), 1_000);
    for (let index = 1; index <= 95; index += 1) {
      harness.internals.ingest(counters(100 + index), 1_000 + index * 1_000);
    }
    expect(harness.poller.clusterHistory()).toHaveLength(90);
    expect(harness.poller.podHistories().get('apps/web')).toHaveLength(90);

    harness.internals.ingest(new Map(), 100_000);
    expect(harness.poller.podHistories().has('apps/web')).toBe(false);
  });

  it('treats counter resets and unchanged counters as a fresh zero-rate baseline', () => {
    const harness = createHarness();
    const pod: RawPeer = { key: 'pod/apps/web', ip: '10.0.0.1', namespace: 'apps', podname: 'web' };
    const outside: RawPeer = { key: 'ip/1.1.1.1', ip: '1.1.1.1' };
    const first = new Map<string, PairCounters>([['pair', { a: pod, b: outside, ab: 100, ba: 50, retrans: 5, drop: 4 }]]);
    const reset = new Map<string, PairCounters>([['pair', { a: pod, b: outside, ab: 10, ba: 5, retrans: 1, drop: 0 }]]);
    harness.internals.ingest(first, 1_000);
    harness.internals.ingest(reset, 2_000);
    expect(harness.poller.latestLinks()).toEqual([]);
    expect(harness.poller.clusterHistory()).toEqual([{ t: 2000, bps: 0 }]);
  });
});

describe('NetworkMetricsPoller lifecycle and failures', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists readiness accurately and reports failed scrape responses', async () => {
    const harness = createHarness({
      pods: [
        { metadata: { name: 'ready' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } },
        { metadata: { name: 'false' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } },
        { metadata: { name: 'succeeded' }, status: { phase: 'Succeeded', conditions: [{ type: 'Ready', status: 'True' }] } },
      ],
      request: async () => response('maintenance', 503),
    });
    expect(await harness.internals.listAgentPods()).toEqual([
      { name: 'ready', ready: true },
      { name: 'false', ready: false },
      { name: 'succeeded', ready: false },
    ]);
    await expect(harness.internals.scrape('pod with spaces')).rejects.toThrow('scrape of pod with spaces failed: 503 Unavailable');
    expect(harness.raw.request.mock.calls.at(-1)?.[0]).toContain('pod%20with%20spaces:10093/proxy/metrics');
  });

  it('marks an established poller unavailable when agents disappear', async () => {
    const harness = createHarness({ pods: [{ metadata: { name: 'pending' }, status: { phase: 'Pending' } }] });
    harness.poller.available = true;
    harness.poller.agentsReporting = 2;
    harness.poller.agentsListed = 2;
    harness.internals.links = [{}];
    harness.internals.prevT = 100;
    await harness.internals.poll();
    expect(harness.poller.available).toBe(false);
    expect(harness.poller.agentsReporting).toBe(0);
    expect(harness.poller.agentsListed).toBe(0);
    expect(harness.poller.latestLinks()).toEqual([]);
    expect(harness.log.info).toHaveBeenCalledWith(expect.anything(), 'network metrics became unavailable');
    harness.poller.stop();
  });

  it('uses the first scrape rejection when every ready agent fails', async () => {
    const harness = createHarness({ request: async () => Promise.reject(new Error('proxy denied')) });
    await harness.internals.poll();
    expect(harness.poller.available).toBe(false);
    expect(harness.poller.agentsReporting).toBe(0);
    harness.poller.stop();
  });

  it('discards a poll whose epoch changes while a scrape is in flight', async () => {
    let resolveRequest!: (value: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const harness = createHarness({ request: async () => request });
    const polling = harness.internals.poll();
    await vi.waitFor(() => expect(harness.raw.request).toHaveBeenCalled());
    harness.poller.markUnavailable();
    resolveRequest(response(metrics(1)));
    await polling;
    expect(harness.poller.available).toBe(false);
    expect(harness.internals.prevCounters.size).toBe(0);
    harness.poller.stop();
  });

  it('resets all state immediately and schedules a slow probe unless stopped', () => {
    const harness = createHarness();
    harness.poller.available = true;
    harness.poller.agentsReporting = 2;
    harness.poller.agentsListed = 3;
    harness.internals.links = [{}];
    harness.internals.prevCounters.set('x', {} as PairCounters);
    harness.internals.prevT = 100;
    harness.internals.cluster.push({});
    harness.internals.pods.set('apps/web', [{}]);
    harness.internals.appliedNamespaces = 'apps';

    harness.poller.markUnavailable();
    expect(harness.poller.available).toBe(false);
    expect(harness.poller.clusterHistory()).toEqual([]);
    expect(harness.poller.podHistories().size).toBe(0);
    expect(harness.internals.epoch).toBe(1);
    expect(harness.internals.timer).toBeDefined();

    harness.poller.stop();
    harness.internals.timer = undefined;
    harness.poller.markUnavailable();
    expect(harness.internals.timer).toBeUndefined();
  });

  it('starts, kicks only when eligible, and stops owned resources', async () => {
    const harness = createHarness();
    const poll = vi.spyOn(harness.internals, 'poll').mockResolvedValue();
    harness.poller.start();
    expect(poll).toHaveBeenCalledTimes(1);

    harness.internals.stopped = false;
    harness.internals.polling = false;
    harness.internals.lastPollStart = 0;
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    harness.poller.kick();
    expect(poll).toHaveBeenCalledTimes(2);

    harness.internals.polling = true;
    harness.poller.kick();
    harness.internals.polling = false;
    harness.internals.lastPollStart = 9_000;
    harness.poller.kick();
    harness.internals.stopped = true;
    harness.poller.kick();
    expect(poll).toHaveBeenCalledTimes(2);

    harness.internals.services = {
      watcher: { items: () => [], ready: async () => {} },
      release: harness.release,
    };
    harness.poller.stop();
    expect(harness.release).toHaveBeenCalled();
    expect(harness.internals.services).toBeUndefined();
  });

  it('does not acquire duplicate service watchers or watchers after stop', () => {
    const harness = createHarness();
    harness.internals.acquireServicesWatcher();
    harness.internals.acquireServicesWatcher();
    expect(harness.watchers.acquire).toHaveBeenCalledTimes(1);
    harness.poller.stop();
    harness.internals.acquireServicesWatcher();
    expect(harness.watchers.acquire).toHaveBeenCalledTimes(1);
  });
});
