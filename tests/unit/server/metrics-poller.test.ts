import type { FastifyBaseLogger } from 'fastify';
import type { Metrics } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsPoller } from '../../../server/src/kube/metrics-poller';

interface PollerInternals {
  nodes: Map<string, unknown[]>;
  pods: Map<string, unknown[]>;
  latestNodes: unknown[];
  latestPods: unknown[];
  timer?: NodeJS.Timeout;
  stopped: boolean;
  polling: boolean;
  lastPollStart: number;
  epoch: number;
  poll(): Promise<void>;
}

function metricsHarness() {
  const getNodeMetrics = vi.fn(async () => ({
    items: [
      { metadata: { name: 'worker-1' }, usage: { cpu: '250m', memory: '1Gi' } },
      { metadata: { name: 'worker-2' }, usage: { cpu: '1.5', memory: '512Mi' } },
    ],
  }));
  const getPodMetrics = vi.fn(async () => ({
    items: [
      {
        metadata: { name: 'web-0', namespace: 'apps' },
        containers: [
          { name: 'app', usage: { cpu: '100m', memory: '128Mi' } },
          { name: 'sidecar', usage: { cpu: '25m', memory: '32Mi' } },
        ],
      },
      { metadata: { name: 'dns', namespace: 'kube-system' }, containers: [{ name: 'dns', usage: { cpu: '10m', memory: '16Mi' } }] },
    ],
  }));
  const metrics = { getNodeMetrics, getPodMetrics } as unknown as Metrics;
  const log = { info: vi.fn() } as unknown as FastifyBaseLogger;
  const poller = new MetricsPoller(metrics, log);
  return {
    poller,
    internals: poller as unknown as PollerInternals,
    getNodeMetrics,
    getPodMetrics,
    log: log as unknown as { info: ReturnType<typeof vi.fn> },
  };
}

describe('MetricsPoller', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls node/container metrics, converts quantities, filters snapshots, and retains histories', async () => {
    const { poller, internals } = metricsHarness();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await internals.poll();

    expect(poller.available).toBe(true);
    expect(poller.probed).toBe(true);
    expect(poller.nodeSnapshot()).toEqual([
      { name: 'worker-1', cpuMilli: 250, memBytes: 1024 ** 3 },
      { name: 'worker-2', cpuMilli: 1500, memBytes: 512 * 1024 ** 2 },
    ]);
    expect(poller.podSnapshot('apps')).toEqual([
      {
        name: 'web-0',
        namespace: 'apps',
        cpuMilli: 125,
        memBytes: 160 * 1024 ** 2,
        containers: [
          { name: 'app', cpuMilli: 100, memBytes: 128 * 1024 ** 2 },
          { name: 'sidecar', cpuMilli: 25, memBytes: 32 * 1024 ** 2 },
        ],
      },
    ]);
    expect(poller.podSnapshot()).toHaveLength(2);
    expect(poller.history('node', 'worker-1')).toEqual([{ t: 1000, cpuMilli: 250, memBytes: 1024 ** 3 }]);
    expect(poller.history('pod', 'web-0', 'apps')).toEqual([{ t: 1000, cpuMilli: 125, memBytes: 160 * 1024 ** 2 }]);
    expect(poller.history('pod', 'missing', 'apps')).toEqual([]);
    expect(poller.nodeHistories()).toBe(internals.nodes);
    expect(poller.podHistories()).toBe(internals.pods);
    poller.stop();
  });

  it('prunes disappeared objects and caps per-object histories at 90 samples', async () => {
    const { poller, internals, getNodeMetrics, getPodMetrics } = metricsHarness();
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    for (let index = 0; index < 95; index += 1) await internals.poll();
    expect(poller.history('node', 'worker-1')).toHaveLength(90);
    expect(poller.history('pod', 'web-0', 'apps')).toHaveLength(90);

    getNodeMetrics.mockResolvedValueOnce({ items: [] });
    getPodMetrics.mockResolvedValueOnce({ items: [] });
    await internals.poll();
    expect(poller.nodeSnapshot()).toEqual([]);
    expect(poller.podSnapshot()).toEqual([]);
    expect(poller.nodeHistories().size).toBe(0);
    expect(poller.podHistories().size).toBe(0);
    poller.stop();
  });

  it('degrades gracefully, logs only transitions, and schedules the slow retry cadence', async () => {
    const { poller, internals, getNodeMetrics, log } = metricsHarness();
    poller.available = true;
    getNodeMetrics.mockRejectedValueOnce(new Error('metrics API unavailable'));
    await internals.poll();
    expect(poller.available).toBe(false);
    expect(poller.probed).toBe(true);
    expect(poller.nodeSnapshot()).toEqual([]);
    expect(poller.podSnapshot()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(expect.anything(), 'metrics became unavailable');
    poller.stop();

    const quiet = metricsHarness();
    quiet.getNodeMetrics.mockRejectedValueOnce(new Error('still unavailable'));
    await quiet.internals.poll();
    expect(quiet.log.info).not.toHaveBeenCalled();
    quiet.poller.stop();
  });

  it('discards in-flight results after an availability reset', async () => {
    const { poller, internals, getNodeMetrics } = metricsHarness();
    let release!: (value: Awaited<ReturnType<typeof getNodeMetrics>>) => void;
    getNodeMetrics.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = internals.poll();
    await vi.waitFor(() => expect(getNodeMetrics).toHaveBeenCalled());
    poller.markUnavailable();
    release({ items: [] });
    await pending;
    expect(poller.available).toBe(false);
    expect(poller.nodeSnapshot()).toEqual([]);
    poller.stop();
  });

  it('starts/stops, kicks only when eligible, and clears stale snapshots immediately', () => {
    const { poller, internals } = metricsHarness();
    const poll = vi.spyOn(internals, 'poll').mockResolvedValue();
    poller.start();
    expect(poll).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    internals.stopped = false;
    internals.polling = false;
    internals.lastPollStart = 0;
    poller.kick();
    expect(poll).toHaveBeenCalledTimes(2);
    internals.polling = true;
    poller.kick();
    internals.polling = false;
    internals.lastPollStart = 9_000;
    poller.kick();
    internals.stopped = true;
    poller.kick();
    expect(poll).toHaveBeenCalledTimes(2);

    internals.stopped = false;
    internals.latestNodes = [{}];
    internals.latestPods = [{}];
    poller.markUnavailable();
    expect(poller.probed).toBe(true);
    expect(poller.nodeSnapshot()).toEqual([]);
    expect(poller.podSnapshot()).toEqual([]);
    expect(internals.epoch).toBe(1);
    expect(internals.timer).toBeDefined();

    poller.stop();
    internals.timer = undefined;
    poller.markUnavailable();
    expect(internals.timer).toBeUndefined();
  });

  it('short-circuits overlapping and stopped polls', async () => {
    const { internals, getNodeMetrics } = metricsHarness();
    internals.stopped = true;
    await internals.poll();
    internals.stopped = false;
    internals.polling = true;
    await internals.poll();
    expect(getNodeMetrics).not.toHaveBeenCalled();
  });
});
