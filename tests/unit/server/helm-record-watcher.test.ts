import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { HelmReleaseChange, HelmWatchStatus } from '@kubus/shared';
import type { RawClient } from '../../../server/src/kube/raw-client.js';
import { HELM_RECORD_WATCH_OPTIONS, HelmRecordWatcher, releaseChange } from '../../../server/src/helm/record-watcher.js';

// The underlying watchers back off through node:timers/promises; resolving it
// immediately keeps retries observable without real waiting.
const delayMock = vi.hoisted(() => vi.fn(async (_ms?: number) => {}));
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: delayMock };
});

type StreamItem = { chunk?: Buffer; end?: boolean; error?: unknown };

class PushStream {
  private queue: StreamItem[] = [];
  private notify?: () => void;

  pushEvent(event: unknown): void {
    this.queue.push({ chunk: Buffer.from(`${JSON.stringify(event)}\n`) });
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

interface RequestRecord {
  path: string;
  headers?: Record<string, string>;
}

/**
 * Answers one LIST per driver plural (a scripted error is consumed, so a
 * retrying watcher parks on the next attempt instead of spinning) and hands
 * out one watch stream per plural.
 */
class FakeRaw {
  lists: RequestRecord[] = [];
  watches: RequestRecord[] = [];
  streams = new Map<string, PushStream>();
  private readonly listResponses = new Map<string, { value?: unknown; error?: unknown }>();

  list(plural: string, value: unknown): void {
    this.listResponses.set(plural, { value });
  }

  listError(plural: string, error: unknown): void {
    this.listResponses.set(plural, { error });
  }

  json(path: string, init?: { headers?: Record<string, string> }): Promise<unknown> {
    this.lists.push({ path, headers: init?.headers });
    const plural = pluralOf(path);
    const response = this.listResponses.get(plural);
    if (!response) return new Promise(() => {});
    if (response.error) {
      this.listResponses.delete(plural);
      return Promise.reject(response.error);
    }
    return Promise.resolve(response.value);
  }

  stream(path: string, init: { signal: AbortSignal; headers?: Record<string, string> }): Promise<{ body: PushStream }> {
    this.watches.push({ path, headers: init.headers });
    const stream = new PushStream();
    init.signal.addEventListener('abort', () => stream.fail(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    this.streams.set(pluralOf(path), stream);
    return Promise.resolve({ body: stream });
  }

  asClient(): RawClient {
    return this as unknown as RawClient;
  }
}

function pluralOf(path: string): string {
  return path.includes('/configmaps') ? 'configmaps' : 'secrets';
}

function record(name: string, resourceVersion: string, labels: Record<string, string>, namespace = 'demo') {
  return { apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadata', metadata: { name, namespace, uid: `${namespace}/${name}`, resourceVersion, labels } };
}

function makeLog(): FastifyBaseLogger {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: (): unknown => log };
  return log as unknown as FastifyBaseLogger;
}

function harness() {
  const raw = new FakeRaw();
  const changes: HelmReleaseChange[][] = [];
  const statuses: HelmWatchStatus[] = [];
  const watcher = new HelmRecordWatcher(raw.asClient(), makeLog(), {
    onChanges: (batch) => changes.push(batch),
    onStatus: (status) => statuses.push(status),
  });
  return { raw, changes, statuses, watcher };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let active: HelmRecordWatcher | undefined;
afterEach(() => {
  active?.stop();
  active = undefined;
  delayMock.mockClear();
});

describe('HelmRecordWatcher', () => {
  it('streams metadata-only, label-filtered records and coalesces changes per release', async () => {
    const { raw, changes, statuses, watcher } = harness();
    active = watcher;
    raw.list('secrets', { metadata: { resourceVersion: '10' }, items: [record('sh.helm.release.v1.podinfo.v1', '9', { owner: 'helm', status: 'deployed' })] });
    raw.list('configmaps', { metadata: { resourceVersion: '4' }, items: [] });

    watcher.start();
    watcher.start();
    await vi.waitFor(() => expect(raw.streams.size).toBe(2));

    const secretsList = raw.lists.find((request) => request.path.includes('/secrets'));
    expect(secretsList?.path).toContain('labelSelector=owner%3Dhelm');
    expect(secretsList?.headers).toEqual(HELM_RECORD_WATCH_OPTIONS.listHeaders);
    const secretsWatch = raw.watches.find((request) => request.path.includes('/secrets'));
    expect(secretsWatch?.path).toContain('labelSelector=owner%3Dhelm');
    expect(secretsWatch?.path).toContain('watch=1');
    expect(secretsWatch?.headers).toEqual(HELM_RECORD_WATCH_OPTIONS.watchHeaders);
    expect(raw.watches.map((request) => request.path).some((path) => path.includes('/configmaps'))).toBe(true);
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: 'live' }));
    // The initial snapshot is not a change.
    expect(changes).toEqual([]);

    const stream = raw.streams.get('secrets')!;
    stream.pushEvent({ type: 'ADDED', object: record('sh.helm.release.v1.podinfo.v2', '11', { owner: 'helm', status: 'pending-upgrade' }) });
    stream.pushEvent({ type: 'MODIFIED', object: record('sh.helm.release.v1.podinfo.v2', '12', { owner: 'helm', status: 'deployed' }) });
    stream.pushEvent({ type: 'MODIFIED', object: record('sh.helm.release.v1.podinfo.v1', '13', { owner: 'helm', status: 'superseded' }) });
    stream.pushEvent({ type: 'ADDED', object: record('sh.helm.release.v1.other.v1', '14', { owner: 'helm', status: 'deployed' }, 'team-b') });
    stream.pushEvent({ type: 'ADDED', object: record('not-a-release', '15', { owner: 'helm' }) });
    await settle(300);

    expect(changes).toEqual([
      [
        { namespace: 'demo', name: 'podinfo', revision: 2, status: 'deployed', type: 'MODIFIED' },
        { namespace: 'team-b', name: 'other', revision: 1, status: 'deployed', type: 'ADDED' },
      ],
    ]);

    stream.pushEvent({ type: 'DELETED', object: record('sh.helm.release.v1.other.v1', '16', { owner: 'helm' }, 'team-b') });
    await settle(300);
    expect(changes[1]).toEqual([{ namespace: 'team-b', name: 'other', revision: 1, status: undefined, type: 'DELETED' }]);

    watcher.stop();
    stream.pushEvent({ type: 'ADDED', object: record('sh.helm.release.v1.late.v1', '17', { owner: 'helm' }) });
    await settle(300);
    expect(changes).toHaveLength(2);
    expect(watcher.status()).toEqual({ state: 'live' });
  });

  it('stays live through configmaps when secrets are forbidden, and is unavailable when both are', async () => {
    const { raw, statuses, watcher } = harness();
    active = watcher;
    raw.listError('secrets', { code: 403, body: { message: 'secrets is forbidden: cannot list resource "secrets" at the cluster scope' } });
    raw.list('configmaps', { metadata: { resourceVersion: '4' }, items: [] });

    watcher.start();
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('live'));
    expect(statuses.at(-1)?.message).toContain('secrets records cannot be watched');
    expect(statuses.at(-1)?.message).toContain('forbidden');
    // A forbidden driver is not retried.
    expect(raw.lists.filter((request) => request.path.includes('/secrets'))).toHaveLength(1);
    watcher.stop();

    const both = harness();
    active = both.watcher;
    both.raw.listError('secrets', { code: 403, body: { message: 'secrets is forbidden' } });
    both.raw.listError('configmaps', { code: 403, body: { message: 'configmaps is forbidden' } });
    both.watcher.start();
    await vi.waitFor(() => expect(both.statuses.at(-1)?.state).toBe('unavailable'));
    expect(both.watcher.status()).toEqual({ state: 'unavailable', message: 'secrets is forbidden' });
  });

  it('keeps retrying, and reports reconnecting, while a list fails transiently', async () => {
    const { raw, statuses, watcher } = harness();
    active = watcher;
    raw.listError('secrets', Object.assign(new Error('apiserver restarting'), { code: 503 }));
    raw.listError('configmaps', Object.assign(new Error('apiserver restarting'), { code: 503 }));

    watcher.start();
    // The retry backs off (through the mocked timer) and lists again.
    await vi.waitFor(() => expect(delayMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(raw.lists.filter((request) => request.path.includes('/secrets')).length).toBeGreaterThan(1));
    expect(statuses.every((status) => status.state === 'reconnecting')).toBe(true);
    expect(watcher.status().state).toBe('reconnecting');
  });
});

describe('releaseChange', () => {
  it('parses release record names and ignores other objects', () => {
    expect(releaseChange({ type: 'MODIFIED', object: record('sh.helm.release.v1.my-app.name.v12', '1', { status: 'deployed' }, 'apps') })).toEqual({
      namespace: 'apps',
      name: 'my-app.name',
      revision: 12,
      status: 'deployed',
      type: 'MODIFIED',
    });
    expect(releaseChange({ type: 'ADDED', object: record('sh.helm.release.v1.broken', '1', {}) })).toBeUndefined();
    expect(releaseChange({ type: 'ADDED', object: record('registry-credentials', '1', { owner: 'helm' }) })).toBeUndefined();
  });
});
