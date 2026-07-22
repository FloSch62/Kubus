/* oxlint-disable typescript/unbound-method -- these assertions intentionally inspect replaced methods. */
import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { ResourceKindInfo } from '@kubus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryCache } from '../../../server/src/kube/discovery';
import type { RawClient } from '../../../server/src/kube/raw-client';
import { ResourceSearchIndex, type IndexedResourceSearchEntry } from '../../../server/src/kube/search-index';

interface Metadata {
  name?: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
}

interface KindState {
  key: string;
  kind: ResourceKindInfo;
  rv: string;
  abort?: AbortController;
  entryIds: Set<string>;
  running: boolean;
  unavailable: boolean;
}

interface SearchIndexInternals {
  entriesById: Map<string, IndexedResourceSearchEntry>;
  entriesSnapshot?: IndexedResourceSearchEntry[];
  idByNameKey: Map<string, string>;
  kinds: Map<string, KindState>;
  started: boolean;
  disposed: boolean;
  reconcileInFlight?: Promise<void>;
  reconcileTimer?: NodeJS.Timeout;
  safetyReconcileTimer?: NodeJS.Timeout;
  crdAbort?: AbortController;
  warm(): void;
  scheduleReconcile(invalidateDiscovery: boolean): void;
  reconcileKinds(): Promise<void>;
  reconcileKindsNow(): Promise<void>;
  startKind(kind: ResourceKindInfo): Promise<void>;
  stopKind(state: KindState): void;
  path(kind: ResourceKindInfo, query: URLSearchParams): string;
  metadataJson<T>(path: string): Promise<T>;
  metadataStream(path: string, signal: AbortSignal): Promise<Response>;
  listKindMetadata(state: KindState, opts?: { quorum?: boolean }): Promise<{ rv: string; items: Array<{ metadata?: Metadata }> }>;
  replaceKindEntries(state: KindState, items: Array<{ metadata?: Metadata }>): void;
  removeKindEntries(state: KindState): void;
  upsertEntry(state: KindState, metadata: Metadata | undefined): void;
  deleteEntry(state: KindState, metadata: Metadata | undefined): void;
  relistKind(state: KindState, opts?: { quorum?: boolean }): Promise<void>;
  kindLoop(state: KindState): Promise<void>;
  listOnlyKindLoop(state: KindState): Promise<void>;
  waitForRetry(ms: number): Promise<boolean>;
  watchKindOnce(state: KindState): Promise<void>;
  processKindWatchLine(state: KindState, event: { type: string; object?: { metadata?: Metadata; code?: number; message?: string } }): void;
  startCrdWatch(): void;
  listCrdResourceVersion(): Promise<string>;
  crdWatchLoop(): Promise<void>;
}

function kind(overrides: Partial<ResourceKindInfo> = {}): ResourceKindInfo {
  return {
    group: '',
    version: 'v1',
    kind: 'Pod',
    plural: 'pods',
    namespaced: true,
    verbs: ['get', 'list', 'watch'],
    ...overrides,
  };
}

function state(resource = kind()): KindState {
  return {
    key: `${resource.group}/${resource.version}/${resource.plural}`,
    kind: resource,
    rv: '',
    entryIds: new Set(),
    running: true,
    unavailable: false,
  };
}

function streamResponse(lines: string, status = 200): Response {
  const body = Readable.from([Buffer.from(lines)]);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 403 ? 'Forbidden' : 'Error',
    body,
    text: async () => lines,
  } as unknown as Response;
}

function createHarness(options: {
  resources?: ResourceKindInfo[];
  json?: (path: string, init?: unknown) => Promise<unknown>;
  request?: (path: string, init?: unknown) => Promise<Response>;
} = {}) {
  const discovery = {
    getResources: vi.fn(async () => options.resources ?? []),
    invalidate: vi.fn(),
  } as unknown as DiscoveryCache;
  const raw = {
    json: vi.fn(options.json ?? (async () => ({ metadata: { resourceVersion: '1' }, items: [] }))),
    request: vi.fn(options.request ?? (async () => streamResponse(''))),
  } as unknown as RawClient;
  const log = { debug: vi.fn() } as unknown as FastifyBaseLogger;
  const index = new ResourceSearchIndex(discovery, raw, log);
  return {
    index,
    internals: index as unknown as SearchIndexInternals,
    discovery: discovery as unknown as { getResources: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> },
    raw: raw as unknown as { json: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> },
    log: log as unknown as { debug: ReturnType<typeof vi.fn> },
  };
}

describe('ResourceSearchIndex entry bookkeeping', () => {
  it('upserts, replaces same-name UIDs, deletes, and lazily snapshots entries', async () => {
    const { index, internals } = createHarness();
    const podState = state();
    internals.kinds.set(podState.key, podState);
    internals.warm = vi.fn();

    internals.upsertEntry(podState, undefined);
    internals.upsertEntry(podState, {});
    internals.upsertEntry(podState, {
      name: 'web-0',
      namespace: 'default',
      uid: 'old',
      labels: { app: 'web', tier: 'frontend' },
    });
    const first = await index.entries();
    expect(first).toEqual([
      expect.objectContaining({ name: 'web-0', namespace: 'default', uid: 'old', labelsText: 'app=web tier=frontend' }),
    ]);
    expect(await index.entries()).toBe(first);

    internals.upsertEntry(podState, { name: 'web-0', namespace: 'default', uid: 'new' });
    const replaced = await index.entries();
    expect(replaced).not.toBe(first);
    expect(replaced).toEqual([expect.objectContaining({ uid: 'new', labelsText: undefined })]);

    internals.deleteEntry(podState, undefined);
    internals.deleteEntry(podState, {});
    internals.deleteEntry(podState, { name: 'web-0', namespace: 'default' });
    expect(await index.entries()).toEqual([]);
  });

  it('replaces and removes every entry for a kind', () => {
    const { internals } = createHarness();
    const podState = state();
    internals.replaceKindEntries(podState, [
      { metadata: { name: 'a', uid: 'a' } },
      { metadata: { name: 'b' } },
      {},
    ]);
    expect(internals.entriesById.size).toBe(2);
    expect(podState.entryIds.size).toBe(2);

    internals.removeKindEntries(podState);
    expect(internals.entriesById.size).toBe(0);
    expect(internals.idByNameKey.size).toBe(0);
    expect(podState.entryIds.size).toBe(0);
  });
});

describe('ResourceSearchIndex Kubernetes I/O', () => {
  it('lists metadata across pages and switches from cache RV to continue tokens', async () => {
    const pages = [
      { metadata: { resourceVersion: '10', continue: 'next' }, items: [{ metadata: { name: 'a' } }] },
      { metadata: { resourceVersion: '10' }, items: [{ metadata: { name: 'b' } }] },
    ];
    const { internals, raw } = createHarness({ json: async () => pages.shift() });
    const result = await internals.listKindMetadata(state());
    expect(result).toEqual({ rv: '10', items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] });
    expect(raw.json).toHaveBeenCalledTimes(2);
    expect(raw.json.mock.calls[0]![0]).toContain('limit=1000');
    expect(raw.json.mock.calls[0]![0]).toContain('resourceVersion=0');
    expect(raw.json.mock.calls[1]![0]).toContain('continue=next');
    expect(raw.json.mock.calls[1]![0]).not.toContain('resourceVersion=0');
  });

  it('uses a quorum list when requested and tolerates omitted list fields', async () => {
    const { internals, raw } = createHarness({ json: async () => ({}) });
    expect(await internals.listKindMetadata(state(), { quorum: true })).toEqual({ rv: '', items: [] });
    expect(raw.json.mock.calls[0]![0]).not.toContain('resourceVersion=0');
  });

  it('turns failed watch responses into structured errors and preserves raw bodies', async () => {
    const jsonHarness = createHarness({ request: async () => streamResponse('{"message":"denied"}', 403) });
    await expect(jsonHarness.internals.metadataStream('/watch', new AbortController().signal)).rejects.toMatchObject({
      code: 403,
      message: expect.stringContaining('denied'),
    });

    const textHarness = createHarness({ request: async () => streamResponse('plain failure', 500) });
    await expect(textHarness.internals.metadataStream('/watch', new AbortController().signal)).rejects.toMatchObject({
      code: 500,
      message: expect.stringContaining('watch failed: 500 Error'),
    });

    const okHarness = createHarness({ request: async () => streamResponse('') });
    await expect(okHarness.internals.metadataStream('/watch', new AbortController().signal)).resolves.toMatchObject({ ok: true });
  });

  it('consumes newline-delimited watch snapshots, bookmarks, updates, and deletes', async () => {
    const lines = [
      '',
      JSON.stringify({ type: 'ADDED', object: { metadata: { name: 'a', uid: 'a', resourceVersion: '2' } } }),
      JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '3' } } }),
      JSON.stringify({ type: 'MODIFIED', object: { metadata: { name: 'a', uid: 'a', resourceVersion: '4', labels: { app: 'new' } } } }),
      JSON.stringify({ type: 'DELETED', object: { metadata: { name: 'a', uid: 'a', resourceVersion: '5' } } }),
      '',
    ].join('\n');
    const { internals } = createHarness({ request: async () => streamResponse(lines) });
    const podState = state();
    podState.rv = '1';
    await internals.watchKindOnce(podState);
    expect(podState.rv).toBe('5');
    expect(internals.entriesById.size).toBe(0);
  });

  it('rejects missing bodies and watch ERROR events', async () => {
    const missing = createHarness({
      request: async () => ({ ok: true, body: null }) as unknown as Response,
    });
    await expect(missing.internals.watchKindOnce(state())).rejects.toThrow('watch response had no body');

    const gone = createHarness({
      request: async () => streamResponse(`${JSON.stringify({ type: 'ERROR', object: { code: 410, message: 'expired' } })}\n`),
    });
    await expect(gone.internals.watchKindOnce(state())).rejects.toMatchObject({
      code: 410,
      message: expect.stringContaining('expired'),
    });

    const failed = createHarness({
      request: async () => streamResponse(`${JSON.stringify({ type: 'ERROR', object: { code: 500 } })}\n`),
    });
    await expect(failed.internals.watchKindOnce(state())).rejects.toThrow('watch error: unknown');
  });
});

describe('ResourceSearchIndex reconciliation and lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('selects watchable built-ins/custom kinds, deduplicates versions, and removes obsolete kinds', async () => {
    const podV1 = kind();
    const podOld = kind({ version: 'v1beta1' });
    const custom = kind({ group: 'example.com', kind: 'Widget', plural: 'widgets', custom: true });
    const ignoredCustom = kind({ group: 'example.com', kind: 'Ignored', plural: 'ignoreds', custom: true, verbs: ['list'] });
    const ignoredBuiltIn = kind({ group: '', kind: 'Event', plural: 'events' });
    const { internals } = createHarness({ resources: [podV1, podOld, custom, ignoredCustom, ignoredBuiltIn] });

    const obsolete = state(kind({ group: 'apps', kind: 'Deployment', plural: 'deployments' }));
    internals.upsertEntry(obsolete, { name: 'old', uid: 'old' });
    internals.kinds.set(obsolete.key, obsolete);
    const starts: ResourceKindInfo[] = [];
    internals.startKind = vi.fn(async (resource) => {
      starts.push(resource);
    });

    await internals.reconcileKindsNow();
    expect(starts).toEqual([podV1, custom]);
    expect(obsolete.running).toBe(false);
    expect(internals.entriesById.size).toBe(0);

    internals.disposed = true;
    await internals.reconcileKindsNow();
    expect(starts).toHaveLength(2);
  });

  it('coalesces scheduled and in-flight reconciliation and handles discovery failure', async () => {
    const { internals, discovery, log } = createHarness();
    const reconcile = vi.fn(async () => {});
    internals.reconcileKinds = reconcile;

    internals.scheduleReconcile(true);
    internals.scheduleReconcile(false);
    expect(discovery.invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    discovery.getResources.mockRejectedValueOnce(new Error('discovery down'));
    await internals.reconcileKindsNow();
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ err: 'Error: discovery down' }), 'search index discovery failed');

    internals.disposed = true;
    internals.scheduleReconcile(true);
    expect(discovery.invalidate).toHaveBeenCalledTimes(1);
  });

  it('starts kinds successfully and classifies unavailable and transient list failures', async () => {
    const success = createHarness();
    const relistSuccess = vi.fn(async (resourceState: KindState) => {
      resourceState.rv = '10';
    });
    const loopSuccess = vi.fn(async () => {});
    success.internals.relistKind = relistSuccess;
    success.internals.kindLoop = loopSuccess;
    await success.internals.startKind(kind());
    expect(success.internals.kinds.size).toBe(1);
    expect(loopSuccess).toHaveBeenCalledTimes(1);
    await success.internals.startKind(kind());
    expect(relistSuccess).toHaveBeenCalledTimes(1);

    const forbidden = createHarness();
    forbidden.internals.relistKind = vi.fn(async () => {
      throw { code: 403 };
    });
    forbidden.internals.kindLoop = vi.fn(async () => {});
    await forbidden.internals.startKind(kind());
    expect([...forbidden.internals.kinds.values()][0]!.unavailable).toBe(true);
    expect(forbidden.log.debug).toHaveBeenCalledWith(expect.anything(), 'search index resource unavailable');

    const transient = createHarness();
    transient.internals.relistKind = vi.fn(async () => {
      throw new Error('reset');
    });
    transient.internals.kindLoop = vi.fn(async () => {});
    await transient.internals.startKind(kind());
    expect(transient.log.debug).toHaveBeenCalledWith(expect.anything(), 'search index initial list failed');
    expect(transient.internals.kindLoop).toHaveBeenCalledTimes(1);
  });

  it('handles watch expiry, forbidden fallback, unavailable resources, and retryable errors', async () => {
    const gone = createHarness();
    const goneState = state();
    goneState.rv = '1';
    gone.internals.watchKindOnce = vi.fn(async () => {
      throw { statusCode: 410 };
    });
    gone.internals.relistKind = vi.fn(async (resourceState: KindState, opts?: { quorum?: boolean }) => {
      expect(opts).toEqual({ quorum: true });
      resourceState.running = false;
    });
    await gone.internals.kindLoop(goneState);
    expect(gone.internals.relistKind).toHaveBeenCalledTimes(1);

    const forbidden = createHarness();
    const forbiddenState = state();
    forbiddenState.rv = '1';
    forbidden.internals.watchKindOnce = vi.fn(async () => {
      throw { body: { code: 403 } };
    });
    forbidden.internals.listOnlyKindLoop = vi.fn(async (resourceState: KindState) => {
      resourceState.running = false;
    });
    await forbidden.internals.kindLoop(forbiddenState);
    expect(forbidden.internals.listOnlyKindLoop).toHaveBeenCalledTimes(1);

    const unavailable = createHarness();
    const unavailableState = state();
    unavailableState.rv = '1';
    unavailable.internals.upsertEntry(unavailableState, { name: 'a', uid: 'a' });
    unavailable.internals.watchKindOnce = vi.fn(async () => {
      throw { code: 404 };
    });
    await unavailable.internals.kindLoop(unavailableState);
    expect(unavailableState.unavailable).toBe(true);
    expect(unavailable.internals.entriesById.size).toBe(0);

    const retry = createHarness();
    const retryState = state();
    retryState.rv = '1';
    retry.internals.watchKindOnce = vi.fn(async () => {
      throw new Error('socket reset');
    });
    retry.internals.waitForRetry = vi.fn(async () => false);
    await retry.internals.kindLoop(retryState);
    expect(retry.log.debug).toHaveBeenCalledWith(expect.anything(), 'search index watch failed');
  });

  it('periodically relists after watch denial and stops on unavailable resources', async () => {
    const retry = createHarness();
    const retryState = state();
    retry.internals.waitForRetry = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    retry.internals.relistKind = vi.fn(async () => {
      throw new Error('temporary');
    });
    await retry.internals.listOnlyKindLoop(retryState);
    expect(retry.log.debug).toHaveBeenCalledWith(expect.anything(), 'search index periodic relist failed');

    const unavailable = createHarness();
    const unavailableState = state();
    unavailable.internals.upsertEntry(unavailableState, { name: 'a', uid: 'a' });
    unavailable.internals.waitForRetry = vi.fn().mockResolvedValueOnce(true);
    unavailable.internals.relistKind = vi.fn(async () => {
      throw { code: 403 };
    });
    await unavailable.internals.listOnlyKindLoop(unavailableState);
    expect(unavailableState.unavailable).toBe(true);
    expect(unavailable.internals.entriesById.size).toBe(0);
  });

  it('warms once, exposes reconciliation state, and disposes timers, watches, and data', async () => {
    const { index, internals } = createHarness();
    const reconcile = vi.fn(async () => {});
    const crd = vi.fn();
    internals.reconcileKinds = reconcile;
    internals.startCrdWatch = crd;

    index.warm();
    index.warm();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(crd).toHaveBeenCalledTimes(1);
    expect(index.isReconciling()).toBe(false);

    const pending = Promise.resolve();
    internals.reconcileInFlight = pending;
    expect(index.isReconciling()).toBe(true);
    internals.reconcileTimer = setTimeout(() => {}, 1000);
    internals.safetyReconcileTimer = setInterval(() => {}, 1000);
    internals.crdAbort = new AbortController();
    const abortSpy = vi.spyOn(internals.crdAbort, 'abort');
    const podState = state();
    podState.abort = new AbortController();
    internals.kinds.set(podState.key, podState);
    internals.upsertEntry(podState, { name: 'a', uid: 'a' });

    index.dispose();
    expect(abortSpy).toHaveBeenCalled();
    expect(podState.running).toBe(false);
    expect(internals.kinds.size).toBe(0);
    expect(internals.entriesById.size).toBe(0);
    index.warm();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceSearchIndex CRD watch', () => {
  it('reads the CRD resource version and schedules discovery reconciliation for changes', async () => {
    const events = [
      JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '2' } } }),
      JSON.stringify({ type: 'MODIFIED', object: { metadata: { resourceVersion: '3' } } }),
      '',
    ].join('\n');
    const { internals, raw } = createHarness({
      json: async () => ({ metadata: { resourceVersion: '1' } }),
      request: async () => streamResponse(events),
    });
    expect(await internals.listCrdResourceVersion()).toBe('1');
    expect(raw.json.mock.calls[0]![0]).toContain('customresourcedefinitions?limit=1');

    internals.scheduleReconcile = vi.fn(() => {
      internals.disposed = true;
    });
    await internals.crdWatchLoop();
    expect(internals.scheduleReconcile).toHaveBeenCalledWith(true);
  });

  it('handles missing bodies, expired watches, forbidden access, and retry exhaustion', async () => {
    const missing = createHarness({ request: async () => ({ ok: true, body: null }) as unknown as Response });
    missing.internals.waitForRetry = vi.fn(async () => false);
    await missing.internals.crdWatchLoop();
    expect(missing.log.debug).toHaveBeenCalledWith(expect.anything(), 'search index CRD watch failed');

    const gone = createHarness({ request: async () => streamResponse(`${JSON.stringify({ type: 'ERROR', object: { code: 410 } })}\n`) });
    gone.internals.scheduleReconcile = vi.fn(() => {
      gone.internals.disposed = true;
    });
    await gone.internals.crdWatchLoop();
    expect(gone.internals.scheduleReconcile).toHaveBeenCalledWith(true);

    const forbidden = createHarness({ request: async () => streamResponse('denied', 403) });
    await forbidden.internals.crdWatchLoop();
    expect(forbidden.log.debug).not.toHaveBeenCalled();

    const failed = createHarness({ request: async () => streamResponse(`${JSON.stringify({ type: 'ERROR', object: { code: 500 } })}\n`) });
    failed.internals.waitForRetry = vi.fn(async () => false);
    await failed.internals.crdWatchLoop();
    expect(failed.log.debug).toHaveBeenCalledWith(expect.anything(), 'search index CRD watch failed');
  });
});
