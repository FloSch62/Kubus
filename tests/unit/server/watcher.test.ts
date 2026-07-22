import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { KubeObject, WatchStatusState } from '@kubus/shared';
import type { RawClient } from '../../../server/src/kube/raw-client.js';
import { ResourceWatcher, WatcherRegistry, type WatcherDelta } from '../../../server/src/kube/watcher.js';

// The watcher awaits node:timers/promises setTimeout between retries; resolving
// it immediately keeps backoff observable without real waiting.
const delayMock = vi.hoisted(() => vi.fn(async (_ms?: number) => {}));
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: delayMock };
});

type StreamItem = { chunk?: Buffer; end?: boolean; error?: unknown };

/** NDJSON stream the test pushes chunks into; consumed via for-await like res.body. */
class PushStream {
  private queue: StreamItem[] = [];
  private notify?: () => void;

  pushEvent(event: unknown): void {
    this.pushRaw(`${JSON.stringify(event)}\n`);
  }

  pushRaw(text: string): void {
    this.queue.push({ chunk: Buffer.from(text) });
    this.notify?.();
  }

  end(): void {
    this.queue.push({ end: true });
    this.notify?.();
  }

  fail(error: unknown): void {
    this.queue.push({ error });
    this.notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.notify = resolve;
        });
      }
      const item = this.queue.shift();
      if (!item) continue;
      if (item.error) throw item.error;
      if (item.end) return;
      if (item.chunk) yield item.chunk;
    }
  }
}

interface ListPage {
  metadata?: { resourceVersion?: string; continue?: string };
  items?: KubeObject[];
}

class FakeRaw {
  jsonCalls: string[] = [];
  streamCalls: string[] = [];
  streams: PushStream[] = [];
  private jsonQueue: Array<{ value?: unknown; error?: unknown }> = [];

  queueList(list: ListPage): void {
    this.jsonQueue.push({ value: list });
  }

  queueListError(error: unknown): void {
    this.jsonQueue.push({ error });
  }

  json(path: string): Promise<unknown> {
    this.jsonCalls.push(path);
    const next = this.jsonQueue.shift();
    // No scripted response: park forever so a runaway retry loop cannot spin.
    if (!next) return new Promise(() => {});
    return next.error ? Promise.reject(next.error) : Promise.resolve(next.value);
  }

  stream(path: string, signal: AbortSignal): Promise<{ body: PushStream }> {
    this.streamCalls.push(path);
    const stream = new PushStream();
    signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    this.streams.push(stream);
    return Promise.resolve({ body: stream });
  }

  streamAt(index: number): PushStream {
    const stream = this.streams[index];
    if (!stream) throw new Error(`no watch stream at index ${index}`);
    return stream;
  }

  asClient(): RawClient {
    return this as unknown as RawClient;
  }
}

function makeLog(): { log: FastifyBaseLogger; warn: ReturnType<typeof vi.fn> } {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: (): unknown => log,
  };
  return { log: log as unknown as FastifyBaseLogger, warn: log.warn };
}

function collector() {
  const batches: WatcherDelta[][] = [];
  const statuses: Array<{ state: WatchStatusState; message?: string }> = [];
  return {
    batches,
    statuses,
    sub: {
      onDeltas: (deltas: WatcherDelta[]) => {
        batches.push(deltas);
      },
      onStatus: (state: WatchStatusState, message?: string) => {
        statuses.push({ state, message });
      },
    },
  };
}

function obj(uid: string, resourceVersion: string, name = uid): KubeObject {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid, resourceVersion } };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  vi.useRealTimers();
  delayMock.mockClear();
});

function makeWatcher(raw: FakeRaw, group = '', version = 'v1', plural = 'pods') {
  const watcher = new ResourceWatcher(raw.asClient(), group, version, plural, 'default', makeLog().log);
  cleanups.push(() => watcher.stop());
  return watcher;
}

describe('ResourceWatcher', () => {
  it('serves a snapshot from the initial list without emitting deltas', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [obj('uid-a', '1', 'a'), obj('uid-b', '2', 'b')] });
    const watcher = makeWatcher(raw);
    const { batches, statuses, sub } = collector();
    watcher.subscribe(sub);

    await watcher.ready();

    expect(raw.jsonCalls[0]).toBe('/api/v1/namespaces/default/pods?limit=1000');
    const snap = watcher.snapshot();
    expect(snap.resourceVersion).toBe('10');
    expect(snap.items.map((o) => o.metadata.uid).sort()).toEqual(['uid-a', 'uid-b']);
    expect(batches).toEqual([]);

    await until(() => statuses.some((s) => s.state === 'live'), 'live status');
    expect(watcher.currentState()).toBe('live');
  });

  it('follows continue tokens across list pages', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10', continue: 'tok' }, items: [obj('uid-a', '1', 'a')] });
    raw.queueList({ metadata: { resourceVersion: '11' }, items: [obj('uid-b', '2', 'b')] });
    // Cluster-scoped (no namespace) watcher.
    const watcher = new ResourceWatcher(raw.asClient(), '', 'v1', 'pods', undefined, makeLog().log);
    cleanups.push(() => watcher.stop());

    await watcher.ready();

    expect(raw.jsonCalls).toEqual(['/api/v1/pods?limit=1000', '/api/v1/pods?limit=1000&continue=tok']);
    expect(watcher.items().map((o) => o.metadata.uid).sort()).toEqual(['uid-a', 'uid-b']);
    expect(watcher.snapshot().resourceVersion).toBe('11');
  });

  it('applies watch events to the uid cache and forwards deltas', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [obj('uid-a', '1', 'a')] });
    const watcher = makeWatcher(raw, 'apps', 'v1', 'deployments');
    const { batches, sub } = collector();
    watcher.subscribe(sub);

    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');
    expect(raw.streamCalls[0]).toContain('/apis/apps/v1/namespaces/default/deployments?');
    expect(raw.streamCalls[0]).toContain('watch=1');
    expect(raw.streamCalls[0]).toContain('resourceVersion=10');

    // prepare() must strip managedFields and backfill apiVersion.
    raw.streamAt(0).pushEvent({
      type: 'ADDED',
      object: { metadata: { name: 'b', namespace: 'default', uid: 'uid-b', resourceVersion: '11', managedFields: [{ manager: 'kubectl' }] } },
    });
    await until(() => batches.length === 1, 'ADDED delta');
    expect(batches[0]).toHaveLength(1);
    const added = batches[0]?.[0];
    expect(added?.type).toBe('ADDED');
    expect(added?.object.apiVersion).toBe('apps/v1');
    expect(added?.object.metadata).not.toHaveProperty('managedFields');
    expect(watcher.items().map((o) => o.metadata.uid).sort()).toEqual(['uid-a', 'uid-b']);

    raw.streamAt(0).pushEvent({ type: 'MODIFIED', object: obj('uid-a', '12', 'a') });
    await until(() => batches.length === 2, 'MODIFIED delta');
    expect(batches[1]?.[0]?.type).toBe('MODIFIED');
    expect(watcher.snapshot().resourceVersion).toBe('12');

    raw.streamAt(0).pushEvent({ type: 'DELETED', object: obj('uid-b', '13', 'b') });
    await until(() => batches.length === 3, 'DELETED delta');
    expect(batches[2]?.[0]?.type).toBe('DELETED');
    expect(watcher.items().map((o) => o.metadata.uid)).toEqual(['uid-a']);
  });

  it('buffers partial lines and batches events arriving in one chunk', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [] });
    const watcher = makeWatcher(raw);
    const { batches, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    const first = JSON.stringify({ type: 'ADDED', object: obj('uid-a', '11', 'a') });
    const second = JSON.stringify({ type: 'ADDED', object: obj('uid-b', '12', 'b') });
    raw.streamAt(0).pushRaw(first.slice(0, 10));
    raw.streamAt(0).pushRaw(`${first.slice(10)}\n${second}\n`);

    await until(() => batches.length === 1, 'batched deltas');
    expect(batches[0]?.map((d) => d.object.metadata.uid)).toEqual(['uid-a', 'uid-b']);
  });

  it('advances resourceVersion on bookmarks without emitting deltas', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [obj('uid-a', '1', 'a')] });
    const watcher = makeWatcher(raw);
    const { batches, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    raw.streamAt(0).pushEvent({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '42' } } });
    await until(() => watcher.snapshot().resourceVersion === '42', 'bookmark rv');
    expect(batches).toEqual([]);
    expect(watcher.items()).toHaveLength(1);

    // A benign stream end reconnects from the bookmarked rv without backoff.
    raw.streamAt(0).end();
    await until(() => raw.streams.length === 2, 'reconnect');
    expect(raw.streamCalls[1]).toContain('resourceVersion=42');
    expect(delayMock).not.toHaveBeenCalled();
  });

  it('recovers from a 410 ERROR event by relisting and synthesizing diff deltas', async () => {
    const raw = new FakeRaw();
    raw.queueList({
      metadata: { resourceVersion: '10' },
      items: [obj('uid-a', '1', 'a'), obj('uid-b', '2', 'b'), obj('uid-c', '3', 'c')],
    });
    const watcher = makeWatcher(raw);
    const { batches, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    // Relist result: b unchanged, c bumped, d new, a gone.
    raw.queueList({
      metadata: { resourceVersion: '20' },
      items: [obj('uid-b', '2', 'b'), obj('uid-c', '30', 'c'), obj('uid-d', '5', 'd')],
    });
    raw.streamAt(0).pushEvent({ type: 'ERROR', object: { code: 410, message: 'too old resource version' } });

    await until(() => batches.length === 1, 'synthetic deltas');
    expect(batches[0]).toHaveLength(3);
    const byUid = new Map((batches[0] ?? []).map((d) => [d.object.metadata.uid, d.type]));
    expect(byUid.get('uid-d')).toBe('ADDED');
    expect(byUid.get('uid-c')).toBe('MODIFIED');
    expect(byUid.get('uid-a')).toBe('DELETED');
    expect(byUid.has('uid-b')).toBe(false);
    const modified = batches[0]?.find((d) => d.type === 'MODIFIED');
    expect(modified?.object.metadata.resourceVersion).toBe('30');

    const snap = watcher.snapshot();
    expect(snap.resourceVersion).toBe('20');
    expect(snap.items.map((o) => o.metadata.uid).sort()).toEqual(['uid-b', 'uid-c', 'uid-d']);

    // The watch resumes from the relisted rv without any backoff sleep.
    await until(() => raw.streams.length === 2, 'watch reconnect');
    expect(raw.streamCalls[1]).toContain('resourceVersion=20');
    expect(delayMock).not.toHaveBeenCalled();
  });

  it('treats a stream failure carrying code 410 as gone and emits nothing when the relist is identical', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [obj('uid-a', '1', 'a')] });
    const watcher = makeWatcher(raw);
    const { batches, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    raw.queueList({ metadata: { resourceVersion: '21' }, items: [obj('uid-a', '1', 'a')] });
    raw.streamAt(0).fail(Object.assign(new Error('Expired'), { code: 410 }));

    await until(() => raw.streams.length === 2, 'watch reconnect');
    expect(raw.streamCalls[1]).toContain('resourceVersion=21');
    expect(batches).toEqual([]);
  });

  it('reports an error and backs off when the relist after 410 fails, then reconnects', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [obj('uid-a', '1', 'a')] });
    const watcher = makeWatcher(raw);
    const { statuses, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    raw.queueListError(Object.assign(new Error('list blew up'), { code: 500 }));
    raw.streamAt(0).pushEvent({ type: 'ERROR', object: { code: 410 } });

    await until(() => raw.streams.length === 2, 'reconnect after backoff');
    expect(statuses.map((s) => s.state)).toEqual(['live', 'error', 'live']);
    expect(delayMock).toHaveBeenCalledWith(1000);
    // The failed relist must not lose the cache or the last good rv.
    expect(raw.streamCalls[1]).toContain('resourceVersion=10');
    expect(watcher.items().map((o) => o.metadata.uid)).toEqual(['uid-a']);
  });

  it('reconnects with status on non-410 watch ERROR events', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [] });
    const watcher = makeWatcher(raw);
    const { statuses, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    raw.streamAt(0).pushEvent({ type: 'ERROR', object: { code: 500, message: 'boom' } });
    await until(() => raw.streams.length === 2, 'reconnect');
    expect(statuses.map((s) => s.state)).toEqual(['live', 'reconnecting', 'live']);
    expect(statuses[1]?.message).toBe('watch error: boom');
    expect(delayMock).toHaveBeenCalledWith(1000);
  });

  it('retries transient list failures with exponential backoff', async () => {
    const raw = new FakeRaw();
    raw.queueListError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    raw.queueListError(Object.assign(new Error('busy'), { code: 503 }));
    raw.queueList({ metadata: { resourceVersion: '5' }, items: [] });
    const watcher = makeWatcher(raw);

    await watcher.ready();

    expect(raw.jsonCalls).toHaveLength(3);
    expect(delayMock.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(watcher.snapshot().resourceVersion).toBe('5');
  });

  it('propagates non-retryable list failures to ready()', async () => {
    const raw = new FakeRaw();
    raw.queueListError(Object.assign(new Error('forbidden'), { code: 403 }));
    const watcher = makeWatcher(raw);

    await expect(watcher.ready()).rejects.toThrow('forbidden');
  });

  it('marks the resource unavailable on a watch 404 and flushes the cache as deletions', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [obj('uid-a', '1', 'a')] });
    const watcher = makeWatcher(raw);
    const { batches, statuses, sub } = collector();
    watcher.subscribe(sub);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    raw.streamAt(0).fail(Object.assign(new Error('the server could not find the requested resource'), { code: 404 }));
    await until(() => statuses.some((s) => s.state === 'unavailable'), 'unavailable status');

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((d) => ({ type: d.type, uid: d.object.metadata.uid }))).toEqual([{ type: 'DELETED', uid: 'uid-a' }]);
    expect(watcher.items()).toEqual([]);
    expect(watcher.snapshot().resourceVersion).toBe('');
    expect(statuses.at(-1)?.message).toBe('Resource API v1/pods is not installed on this cluster.');

    // start() is a no-op once unavailable.
    watcher.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.streamCalls).toHaveLength(1);
    expect(watcher.currentState()).toBe('unavailable');
  });

  it('marks unavailable from a 404 on the initial list, preferring the API message', async () => {
    const raw = new FakeRaw();
    raw.queueListError(Object.assign(new Error('nf'), { code: 404, body: { message: 'the server could not find the requested resource' } }));
    const watcher = makeWatcher(raw, 'example.io', 'v1', 'widgets');
    const { statuses, sub } = collector();
    watcher.subscribe(sub);

    await watcher.ready();

    expect(watcher.currentState()).toBe('unavailable');
    expect(statuses).toEqual([{ state: 'unavailable', message: 'the server could not find the requested resource' }]);
    expect(raw.streamCalls).toHaveLength(0);
  });

  it('isolates a throwing subscriber from the others', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [] });
    const { log, warn } = makeLog();
    const watcher = new ResourceWatcher(raw.asClient(), '', 'v1', 'pods', 'default', log);
    cleanups.push(() => watcher.stop());
    const bad = {
      onDeltas: () => {
        throw new Error('subscriber bug');
      },
      onStatus: () => {},
    };
    const { batches, sub } = collector();
    watcher.subscribe(bad);
    const unsubscribe = watcher.subscribe(sub);
    expect(watcher.subscriberCount).toBe(2);

    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');
    raw.streamAt(0).pushEvent({ type: 'ADDED', object: obj('uid-a', '11', 'a') });
    await until(() => batches.length === 1, 'delta despite throwing subscriber');
    expect(warn).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(watcher.subscriberCount).toBe(1);
    raw.streamAt(0).pushEvent({ type: 'ADDED', object: obj('uid-b', '12', 'b') });
    await until(() => watcher.items().length === 2, 'cache update after unsubscribe');
    expect(batches).toHaveLength(1);
  });

  it('stop() aborts the active watch and prevents reconnects', async () => {
    const raw = new FakeRaw();
    raw.queueList({ metadata: { resourceVersion: '10' }, items: [] });
    const watcher = makeWatcher(raw);
    await watcher.ready();
    await until(() => raw.streams.length === 1, 'watch stream');

    watcher.stop();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(raw.streamCalls).toHaveLength(1);
  });
});

describe('WatcherRegistry', () => {
  function makeRegistry() {
    const raw = new FakeRaw();
    const registry = new WatcherRegistry(raw.asClient(), makeLog().log);
    cleanups.push(() => registry.stopAll());
    return registry;
  }

  it('shares one watcher per key and separates namespaces', () => {
    const registry = makeRegistry();
    const a = registry.acquire('', 'v1', 'pods', 'default');
    const b = registry.acquire('', 'v1', 'pods', 'default');
    const other = registry.acquire('', 'v1', 'pods', 'other');

    expect(a.watcher).toBe(b.watcher);
    expect(other.watcher).not.toBe(a.watcher);
    expect(registry.peek('', 'v1', 'pods', 'default')).toBe(a.watcher);
    expect(registry.peek('', 'v1', 'pods', 'missing')).toBeUndefined();
  });

  it('keeps a watcher alive while any ref remains', () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const a = registry.acquire('', 'v1', 'pods');
    const b = registry.acquire('', 'v1', 'pods');
    const stop = vi.spyOn(a.watcher, 'stop');

    a.release();
    vi.advanceTimersByTime(120_000);
    expect(stop).not.toHaveBeenCalled();
    expect(registry.peek('', 'v1', 'pods')).toBe(b.watcher);
  });

  it('stops and evicts a watcher only after the 30s release linger', () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const a = registry.acquire('', 'v1', 'pods');
    const stop = vi.spyOn(a.watcher, 'stop');

    a.release();
    expect(registry.peek('', 'v1', 'pods')).toBe(a.watcher);
    vi.advanceTimersByTime(29_999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.peek('', 'v1', 'pods')).toBeUndefined();
  });

  it('re-acquiring during the linger cancels eviction and reuses the watcher', () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const a = registry.acquire('', 'v1', 'pods');
    a.release();

    const b = registry.acquire('', 'v1', 'pods');
    expect(b.watcher).toBe(a.watcher);
    const stop = vi.spyOn(b.watcher, 'stop');
    vi.advanceTimersByTime(120_000);
    expect(stop).not.toHaveBeenCalled();
    expect(registry.peek('', 'v1', 'pods')).toBe(b.watcher);
  });

  it('ignores a double release of the same handle', () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const a = registry.acquire('', 'v1', 'pods');
    const b = registry.acquire('', 'v1', 'pods');
    const stop = vi.spyOn(a.watcher, 'stop');

    a.release();
    a.release();
    vi.advanceTimersByTime(120_000);
    expect(stop).not.toHaveBeenCalled();

    b.release();
    vi.advanceTimersByTime(30_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stopAll stops every watcher and clears pending lingers', () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const a = registry.acquire('', 'v1', 'pods');
    const c = registry.acquire('apps', 'v1', 'deployments');
    const stopA = vi.spyOn(a.watcher, 'stop');
    const stopC = vi.spyOn(c.watcher, 'stop');
    a.release();

    registry.stopAll();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopC).toHaveBeenCalledTimes(1);
    expect(registry.peek('', 'v1', 'pods')).toBeUndefined();
    expect(registry.peek('apps', 'v1', 'deployments')).toBeUndefined();
    vi.advanceTimersByTime(120_000);
    expect(stopA).toHaveBeenCalledTimes(1);
  });
});
