/* oxlint-disable typescript/unbound-method -- these assertions intentionally inspect replaced methods. */
import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { ResourceKindInfo } from '@kubus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryCache } from '../../../server/src/kube/discovery';
import { H2UnavailableError } from '../../../server/src/kube/h2-transport';
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
  multiplexed: boolean;
  reconcileInFlight?: Promise<void>;
  reconcileQueued: boolean;
  safetyReconcileTimer?: NodeJS.Timeout;
  customCache?: { signature: string; refreshedAt: number; entries: IndexedResourceSearchEntry[] };
  customRefresh?: { signature: string; promise: Promise<IndexedResourceSearchEntry[]> };
  customGeneration: number;
  warm(): void;
  reconcileKinds(): Promise<void>;
  reconcileKindsNow(): Promise<void>;
  startKind(kind: ResourceKindInfo): Promise<void>;
  stopKind(state: KindState): void;
  path(kind: ResourceKindInfo, query: URLSearchParams): string;
  metadataJson<T>(path: string): Promise<T>;
  metadataStream(path: string, signal: AbortSignal, h2Required: boolean): Promise<Response>;
  listResourceMetadata(resource: ResourceKindInfo, opts?: { quorum?: boolean }): Promise<{ rv: string; items: Array<{ metadata?: Metadata }> }>;
  listKindMetadata(state: KindState, opts?: { quorum?: boolean }): Promise<{ rv: string; items: Array<{ metadata?: Metadata }> }>;
  refreshCustomEntries(resources: ResourceKindInfo[], signature: string): Promise<IndexedResourceSearchEntry[]>;
  scanCustomEntries(resources: ResourceKindInfo[]): Promise<IndexedResourceSearchEntry[]>;
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
  stream?: (path: string, init?: unknown) => Promise<Response>;
  multiplexed?: boolean | (() => Promise<boolean>);
} = {}) {
  const discovery = {
    getResources: vi.fn(async () => options.resources ?? []),
    invalidate: vi.fn(),
  } as unknown as DiscoveryCache;
  const multiplexed = options.multiplexed ?? false;
  const raw = {
    json: vi.fn(options.json ?? (async () => ({ metadata: { resourceVersion: '1' }, items: [] }))),
    request: vi.fn(async () => streamResponse('')),
    stream: vi.fn(options.stream ?? (async () => streamResponse(''))),
    supportsMultiplexedWatch: vi.fn(typeof multiplexed === 'function' ? multiplexed : async () => multiplexed),
  } as unknown as RawClient;
  const log = { debug: vi.fn() } as unknown as FastifyBaseLogger;
  const index = new ResourceSearchIndex(discovery, raw, log);
  return {
    index,
    internals: index as unknown as SearchIndexInternals,
    discovery: discovery as unknown as { getResources: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> },
    raw: raw as unknown as { json: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn>; supportsMultiplexedWatch: ReturnType<typeof vi.fn> },
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

  it('opens metadata watches through the multiplexing-aware stream API and propagates failures', async () => {
    const { internals, raw } = createHarness();
    const signal = new AbortController().signal;
    await expect(internals.metadataStream('/watch', signal, true)).resolves.toMatchObject({ ok: true });
    expect(raw.stream).toHaveBeenCalledWith('/watch', {
      headers: { accept: expect.stringContaining('PartialObjectMetadata') },
      signal,
      h2Required: true,
    });

    const denied = createHarness({
      stream: async () => {
        throw Object.assign(new Error('denied'), { code: 403 });
      },
    });
    await expect(denied.internals.metadataStream('/watch', signal, false)).rejects.toMatchObject({
      code: 403,
      message: expect.stringContaining('denied'),
    });
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
    const { internals } = createHarness({ stream: async () => streamResponse(lines) });
    const podState = state();
    podState.rv = '1';
    await internals.watchKindOnce(podState);
    expect(podState.rv).toBe('5');
    expect(internals.entriesById.size).toBe(0);
  });

  it('rejects missing bodies and watch ERROR events', async () => {
    const missing = createHarness({
      stream: async () => ({ ok: true, body: null }) as unknown as Response,
    });
    await expect(missing.internals.watchKindOnce(state())).rejects.toThrow('watch response had no body');

    const gone = createHarness({
      stream: async () => streamResponse(`${JSON.stringify({ type: 'ERROR', object: { code: 410, message: 'expired' } })}\n`),
    });
    await expect(gone.internals.watchKindOnce(state())).rejects.toMatchObject({
      code: 410,
      message: expect.stringContaining('expired'),
    });

    const failed = createHarness({
      stream: async () => streamResponse(`${JSON.stringify({ type: 'ERROR', object: { code: 500 } })}\n`),
    });
    await expect(failed.internals.watchKindOnce(state())).rejects.toThrow('watch error: unknown');
  });
});

describe('ResourceSearchIndex custom-resource search', () => {
  it('scans every listable CRD with bounded metadata-only concurrency and caches the snapshot', async () => {
    let active = 0;
    let maxActive = 0;
    const customResources = Array.from({ length: 200 }, (_, i) =>
      kind({ group: `eda-${i}.example.com`, version: 'v1', kind: `EdaResource${i}`, plural: `resources${i}`, custom: true }),
    );
    const resources = customResources.flatMap((resource) => [resource, { ...resource, version: 'v1alpha1' }]);
    resources.push(kind({ group: 'ignored.example.com', kind: 'Ignored', plural: 'ignoreds', custom: true, verbs: ['get'] }));
    resources.push(kind());

    const { index, raw } = createHarness({
      json: async (path) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        const plural = path.split('?')[0]!.split('/').at(-1)!;
        return {
          metadata: { resourceVersion: '1' },
          items: [{ metadata: { name: `${plural}-instance`, namespace: 'eda', uid: `uid-${plural}`, labels: { app: 'eda' } } }],
        };
      },
    });

    const first = await index.customEntries(resources);
    expect(first).toHaveLength(200);
    expect(first).toContainEqual(
      expect.objectContaining({ name: 'resources0-instance', namespace: 'eda', uid: 'uid-resources0', labelsText: 'app=eda' }),
    );
    expect(maxActive).toBe(8);
    expect(raw.json).toHaveBeenCalledTimes(200);
    expect(raw.request).not.toHaveBeenCalled();
    expect(raw.json.mock.calls[0]![0]).toContain('resourceVersion=0');
    expect(raw.json.mock.calls[0]![1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ accept: expect.stringContaining('PartialObjectMetadataList') }) }));

    expect(await index.customEntries(resources)).toBe(first);
    expect(raw.json).toHaveBeenCalledTimes(200);

    index.invalidateCustomEntries();
    const refreshed = await index.customEntries(resources);
    expect(refreshed).not.toBe(first);
    expect(raw.json).toHaveBeenCalledTimes(400);
  });

  it('degrades a forbidden CRD independently and does not cache an invalidated in-flight generation', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let scanStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    let calls = 0;
    const resource = kind({ group: 'eda.example.com', kind: 'Fabric', plural: 'fabrics', custom: true });
    const { index, log } = createHarness({
      json: async () => {
        calls += 1;
        if (calls === 1) {
          scanStarted();
          await firstGate;
        }
        if (calls === 2) throw { code: 403 };
        return { items: [{ metadata: { name: 'fabric-a' } }] };
      },
    });

    const outdated = index.customEntries([resource]);
    await started;
    index.invalidateCustomEntries();
    releaseFirst();
    await outdated;
    expect((index as unknown as SearchIndexInternals).customCache).toBeUndefined();

    expect(await index.customEntries([resource])).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ gvr: 'eda.example.com/v1/fabrics' }), 'custom resource search list failed');
    index.invalidateCustomEntries();
    await expect(index.customEntries([resource])).resolves.toEqual([expect.objectContaining({ name: 'fabric-a' })]);
  });
});

describe('ResourceSearchIndex reconciliation and lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('bounds indexing to watchable built-ins, deduplicates versions, and removes obsolete kinds', async () => {
    const podV1 = kind();
    const podOld = kind({ version: 'v1beta1' });
    const customResources = Array.from({ length: 200 }, (_, i) =>
      kind({ group: `example-${i}.com`, kind: `Widget${i}`, plural: `widgets${i}`, custom: true }),
    );
    const ignoredCustom = kind({ group: 'example.com', kind: 'Ignored', plural: 'ignoreds', custom: true, verbs: ['list'] });
    const ignoredBuiltIn = kind({ group: '', kind: 'Event', plural: 'events' });
    const { internals } = createHarness({ resources: [podV1, podOld, ...customResources, ignoredCustom, ignoredBuiltIn] });

    const obsolete = state(kind({ group: 'apps', kind: 'Deployment', plural: 'deployments' }));
    internals.upsertEntry(obsolete, { name: 'old', uid: 'old' });
    internals.kinds.set(obsolete.key, obsolete);
    const starts: ResourceKindInfo[] = [];
    internals.startKind = vi.fn(async (resource) => {
      starts.push(resource);
    });

    await internals.reconcileKindsNow();
    expect(starts).toEqual([podV1]);
    expect(obsolete.running).toBe(false);
    expect(internals.entriesById.size).toBe(0);

    internals.disposed = true;
    await internals.reconcileKindsNow();
    expect(starts).toHaveLength(1);
  });

  it('watches every listable+watchable custom kind live when watches multiplex over HTTP/2', async () => {
    const podV1 = kind();
    const customResources = Array.from({ length: 200 }, (_, i) =>
      kind({ group: `eda-${i}.example.com`, kind: `EdaResource${i}`, plural: `resources${i}`, custom: true }),
    );
    const duplicateVersions = customResources.map((resource) => ({ ...resource, version: 'v1alpha1' }));
    const listOnlyCustom = kind({ group: 'example.com', kind: 'ListOnly', plural: 'listonlys', custom: true, verbs: ['list'] });
    const noisyBuiltIn = kind({ group: 'coordination.k8s.io', kind: 'Lease', plural: 'leases' });
    const { index, internals, raw } = createHarness({
      resources: [podV1, ...customResources, ...duplicateVersions, listOnlyCustom, noisyBuiltIn],
      multiplexed: true,
    });

    const starts: ResourceKindInfo[] = [];
    internals.startKind = vi.fn(async (resource) => {
      starts.push(resource);
    });

    await internals.reconcileKindsNow();
    expect(internals.multiplexed).toBe(true);
    expect(starts).toHaveLength(201);
    expect(starts[0]).toBe(podV1);
    expect(starts.filter((s) => s.custom)).toHaveLength(200);
    expect(starts.every((s) => s.version === 'v1')).toBe(true);

    // Custom instances are already live in entries(); search must not scan.
    await expect(index.customEntries([podV1, ...customResources])).resolves.toEqual([]);
    expect(raw.json).not.toHaveBeenCalled();
  });

  it('drops a custom watch and reconciles instead of falling back to per-watch sockets when HTTP/2 is lost', async () => {
    const { internals } = createHarness();
    const customState = state(kind({ group: 'eda.example.com', kind: 'Fabric', plural: 'fabrics', custom: true }));
    customState.rv = '1';
    internals.kinds.set(customState.key, customState);
    internals.upsertEntry(customState, { name: 'fabric-a', uid: 'a' });
    internals.watchKindOnce = vi.fn(async () => {
      throw new H2UnavailableError('transport gone');
    });
    const reconcile = vi.fn(async () => {});
    internals.reconcileKinds = reconcile;

    await internals.kindLoop(customState);
    expect(customState.running).toBe(false);
    expect(internals.kinds.size).toBe(0);
    expect(internals.entriesById.size).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles on CRD changes and queues one follow-up when a reconcile is already running', async () => {
    const { index, internals } = createHarness();

    // Not started yet: only the scan cache is dropped, nothing warms.
    const early = vi.fn(async () => {});
    internals.reconcileKinds = early;
    index.onCrdChange();
    expect(early).not.toHaveBeenCalled();

    const { index: live, internals: liveInternals } = createHarness();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runs = vi.fn(async () => gate);
    liveInternals.reconcileKindsNow = runs;
    liveInternals.started = true;

    const first = liveInternals.reconcileKinds();
    live.onCrdChange();
    live.onCrdChange();
    expect(runs).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await Promise.resolve();
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('handles discovery failure without disturbing the existing index', async () => {
    const { internals, discovery, log } = createHarness();
    const existing = state();
    internals.kinds.set(existing.key, existing);
    discovery.getResources.mockRejectedValueOnce(new Error('discovery down'));
    await internals.reconcileKindsNow();
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ err: 'Error: discovery down' }), 'search index discovery failed');
    expect(internals.kinds.get(existing.key)).toBe(existing);
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
    internals.reconcileKinds = reconcile;

    index.warm();
    index.warm();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(index.isReconciling()).toBe(false);

    const pending = Promise.resolve();
    internals.reconcileInFlight = pending;
    expect(index.isReconciling()).toBe(true);
    internals.safetyReconcileTimer = setInterval(() => {}, 1000);
    const podState = state();
    podState.abort = new AbortController();
    internals.kinds.set(podState.key, podState);
    internals.upsertEntry(podState, { name: 'a', uid: 'a' });

    index.dispose();
    expect(podState.running).toBe(false);
    expect(internals.kinds.size).toBe(0);
    expect(internals.entriesById.size).toBe(0);
    index.warm();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
