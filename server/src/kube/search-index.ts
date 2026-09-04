import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { ApiException } from '@kubernetes/client-node';
import { BUILTIN_NAV_GROUPS, type ResourceKindInfo, type WatchEventType } from '@kubus/shared';
import type { DiscoveryCache } from './discovery.js';
import { H2UnavailableError } from './h2-transport.js';
import { resourcePath, type RawClient, type StreamResponse } from './raw-client.js';

const LIST_PAGE_SIZE = 1_000;
const START_CONCURRENCY = 16;
const CUSTOM_LIST_CONCURRENCY = 8;
const CUSTOM_CACHE_TTL_MS = 60_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const WATCH_FORBIDDEN_RELIST_MS = 60_000;
const DISCOVERY_SAFETY_RECONCILE_MS = 5 * 60_000;
const METADATA_LIST_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json';
const METADATA_WATCH_ACCEPT = 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json';

const BUILTIN_RESOURCE_SEARCH_KINDS = new Set(
  BUILTIN_NAV_GROUPS.flatMap((g) => g.kinds)
    .filter((k) => ['Pod', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Ingress', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Node', 'Namespace'].includes(k.kind))
    .map((k) => gvrKey(k)),
);

export interface IndexedResourceSearchEntry {
  kind: ResourceKindInfo;
  name: string;
  namespace?: string;
  uid?: string;
  labelsText?: string;
  labels?: Record<string, string>;
}

interface Metadata {
  name?: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
}

interface MetadataObject {
  metadata?: Metadata;
  code?: number;
  message?: string;
}

interface MetadataList {
  metadata?: { resourceVersion?: string; continue?: string };
  items?: MetadataObject[];
}

interface WatchLine {
  type: WatchEventType | 'BOOKMARK' | 'ERROR';
  object?: MetadataObject;
}

interface IndexedKindState {
  key: string;
  kind: ResourceKindInfo;
  rv: string;
  abort?: AbortController;
  entryIds: Set<string>;
  running: boolean;
  unavailable: boolean;
}

interface CustomEntriesCache {
  signature: string;
  refreshedAt: number;
  entries: IndexedResourceSearchEntry[];
}

interface CustomRefresh {
  signature: string;
  promise: Promise<IndexedResourceSearchEntry[]>;
}

function gvrKey(kind: Pick<ResourceKindInfo, 'group' | 'version' | 'plural'>): string {
  return `${kind.group}/${kind.version}/${kind.plural}`;
}

function nameKey(kindKey: string, metadata: Metadata): string | undefined {
  if (!metadata.name) return undefined;
  return `${kindKey}|${metadata.namespace ?? ''}|${metadata.name}`;
}

function entryId(kindKey: string, metadata: Metadata): string | undefined {
  const stable = metadata.uid ?? metadata.name;
  if (!stable) return undefined;
  return `${kindKey}|${metadata.namespace ?? ''}|${stable}`;
}

function labelsText(labels: Record<string, string> | undefined): string | undefined {
  const text = Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return text || undefined;
}

function shouldIndexKind(kind: ResourceKindInfo, multiplexed: boolean): boolean {
  if (!kind.verbs.includes('list') || !kind.verbs.includes('watch')) return false;
  if (BUILTIN_RESOURCE_SEARCH_KINDS.has(gvrKey(kind))) return true;
  // Custom-resource cardinality is unbounded. Live per-CRD watches are only
  // affordable when they multiplex over shared HTTP/2 connections — one watch
  // per CRD over HTTP/1.1 made each Kubus session consume hundreds of sockets
  // and exhausted API servers. Without HTTP/2, custom instances fall back to
  // the bounded scans below. High-churn built-ins outside the curated set
  // (leases, events, endpointslices) stay out either way: they are noise in
  // name search, not missing coverage.
  return multiplexed && kind.custom === true;
}

function customSearchKinds(resources: ResourceKindInfo[]): ResourceKindInfo[] {
  const kinds: ResourceKindInfo[] = [];
  const seen = new Set<string>();
  for (const kind of resources) {
    if (!kind.custom || !kind.verbs.includes('list')) continue;
    // Served versions expose the same objects. Discovery is preferred-first,
    // so scan one version per group/plural and avoid duplicate search hits.
    const resource = `${kind.group}/${kind.plural}`;
    if (seen.has(resource)) continue;
    seen.add(resource);
    kinds.push(kind);
  }
  return kinds;
}

function apiStatusCode(err: unknown): number | undefined {
  return (
    (err as { code?: number })?.code ??
    (err as { statusCode?: number })?.statusCode ??
    ((err as { body?: { code?: unknown } })?.body?.code as number | undefined)
  );
}

function isGone(err: unknown): boolean {
  return apiStatusCode(err) === 410;
}

function isForbidden(err: unknown): boolean {
  return apiStatusCode(err) === 403;
}

function isUnavailable(err: unknown): boolean {
  const code = apiStatusCode(err);
  return code === 403 || code === 404;
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

function apiException(status: number, message: string, body: unknown): ApiException<unknown> {
  return new ApiException(status, message, body, {});
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Names-only global search index, started lazily by the first search.
 *
 * When the API server multiplexes watches over HTTP/2 (the normal case),
 * every custom resource kind is indexed live alongside the curated built-ins —
 * hundreds of metadata watches share one or two TCP connections, so instance
 * search stays current through CR churn and CRD installs.
 *
 * When only HTTP/1.1 is available, custom kinds fall back to bounded
 * metadata-only scans with a short shared cache: no per-CRD persistent
 * sockets, and no repeated fan-out while a user types.
 */
export class ResourceSearchIndex {
  private entriesById = new Map<string, IndexedResourceSearchEntry>();
  /** Snapshot of entriesById.values(), rebuilt lazily after mutations. */
  private entriesSnapshot?: IndexedResourceSearchEntry[];
  private idByNameKey = new Map<string, string>();
  private kinds = new Map<string, IndexedKindState>();
  private started = false;
  private disposed = false;
  private multiplexed = false;
  private reconcileInFlight?: Promise<void>;
  private reconcileQueued = false;
  private safetyReconcileTimer?: NodeJS.Timeout;
  private customCache?: CustomEntriesCache;
  private customRefresh?: CustomRefresh;
  private customGeneration = 0;
  private readonly lifecycleAbort = new AbortController();

  constructor(
    private discovery: DiscoveryCache,
    private raw: RawClient,
    private log: FastifyBaseLogger,
  ) {}

  warm(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.reconcileKinds();
    this.safetyReconcileTimer = setInterval(() => {
      this.discovery.invalidate();
      void this.reconcileKinds();
    }, DISCOVERY_SAFETY_RECONCILE_MS);
    this.safetyReconcileTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleAbort.abort();
    if (this.safetyReconcileTimer) clearInterval(this.safetyReconcileTimer);
    for (const state of this.kinds.values()) this.stopKind(state);
    this.kinds.clear();
    this.entriesById.clear();
    this.entriesSnapshot = undefined;
    this.idByNameKey.clear();
    this.customCache = undefined;
    this.customRefresh = undefined;
    this.customGeneration += 1;
  }

  /** Shared snapshot — callers must not mutate the returned array. */
  async entries(): Promise<IndexedResourceSearchEntry[]> {
    this.warm();
    // With lazy startup, the first search request owns the initial warmup.
    // Wait for the bounded built-in lists so that request returns real results
    // instead of an empty transient snapshot.
    await this.reconcileInFlight;
    this.entriesSnapshot ??= [...this.entriesById.values()];
    return this.entriesSnapshot;
  }

  /**
   * Custom-resource instances for search. With multiplexed watches this is
   * empty — custom kinds are already live in entries(). On HTTP/1.1-only
   * clusters it scans without watches: the first global search performs one
   * bounded metadata sweep; subsequent searches use the shared snapshot, and
   * stale snapshots return immediately while refreshing.
   */
  async customEntries(resources: ResourceKindInfo[]): Promise<IndexedResourceSearchEntry[]> {
    if (this.disposed) return [];
    this.warm();
    // Wait for the reconcile that decides the transport mode (and, when
    // multiplexed, already lists every custom kind) before choosing to scan.
    await this.reconcileInFlight;
    if (this.multiplexed || this.disposed) return [];
    const kinds = customSearchKinds(resources);
    const signature = kinds.map(gvrKey).join('\n');
    const cached = this.customCache;
    if (cached?.signature === signature) {
      if (Date.now() - cached.refreshedAt >= CUSTOM_CACHE_TTL_MS) void this.refreshCustomEntries(kinds, signature);
      return cached.entries;
    }
    return this.refreshCustomEntries(kinds, signature);
  }

  /**
   * Whether custom kinds are kept current by live watches. Reference lookups
   * use the index for names and labels when this holds and read the objects
   * themselves otherwise.
   */
  customKindsLive(): boolean {
    return this.started && this.multiplexed && !this.disposed;
  }

  /** Whether one kind has been listed and is being watched, so its entries are complete. */
  isLive(group: string, plural: string): boolean {
    const state = this.stateFor(group, plural);
    return !!state && state.running && !state.unavailable && !!state.rv;
  }

  /** Current entries of one kind; empty when the kind is not indexed. */
  entriesForKind(group: string, plural: string): IndexedResourceSearchEntry[] {
    const state = this.stateFor(group, plural);
    if (!state) return [];
    const out: IndexedResourceSearchEntry[] = [];
    for (const id of state.entryIds) {
      const entry = this.entriesById.get(id);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** One object by name, from the live index. */
  lookup(group: string, plural: string, namespace: string | undefined, name: string): IndexedResourceSearchEntry | undefined {
    const state = this.stateFor(group, plural);
    if (!state) return undefined;
    const id = this.idByNameKey.get(`${state.key}|${namespace ?? ''}|${name}`);
    return id ? this.entriesById.get(id) : undefined;
  }

  /** Everything indexed so far, without waiting for a reconcile in flight. */
  liveEntries(): IndexedResourceSearchEntry[] {
    this.entriesSnapshot ??= [...this.entriesById.values()];
    return this.entriesSnapshot;
  }

  private stateFor(group: string, plural: string): IndexedKindState | undefined {
    for (const state of this.kinds.values()) {
      if (state.kind.group === group && state.kind.plural === plural) return state;
    }
    return undefined;
  }

  /** CRD discovery changed; force the next search to rebuild its custom snapshot. */
  invalidateCustomEntries(): void {
    this.customCache = undefined;
    this.customRefresh = undefined;
    this.customGeneration += 1;
  }

  /**
   * The cluster's CRD set changed (CrdTracker). Drop the scan cache, and — if
   * the index is live — reconcile now so freshly installed kinds get watches
   * within seconds instead of at the next safety interval.
   */
  onCrdChange(): void {
    this.invalidateCustomEntries();
    if (this.started && !this.disposed) void this.reconcileKinds();
  }

  isReconciling(): boolean {
    this.warm();
    return !!this.reconcileInFlight;
  }

  private async reconcileKinds(): Promise<void> {
    if (this.reconcileInFlight) {
      // A CRD change mid-reconcile must not be lost until the safety interval:
      // remember it and run again once the current pass finishes.
      this.reconcileQueued = true;
      return this.reconcileInFlight;
    }
    this.reconcileInFlight = this.reconcileKindsNow().finally(() => {
      this.reconcileInFlight = undefined;
      if (this.reconcileQueued && !this.disposed) {
        this.reconcileQueued = false;
        void this.reconcileKinds();
      }
    });
    return this.reconcileInFlight;
  }

  private async reconcileKindsNow(): Promise<void> {
    if (this.disposed) return;
    let resources: ResourceKindInfo[];
    try {
      resources = await this.discovery.getResources();
    } catch (err) {
      this.log.debug({ err: String(err) }, 'search index discovery failed');
      return;
    }

    try {
      this.multiplexed = await this.raw.supportsMultiplexedWatch();
    } catch (err) {
      // Transport probe failed (cluster unreachable, dial error): assume the
      // conservative mode for this round; the next reconcile re-probes.
      this.multiplexed = false;
      this.log.debug({ err: String(err) }, 'multiplexed watch probe failed');
    }

    // Every served version of a resource exposes the same objects, so index
    // one version per group/plural. Discovery lists versions preferred-first
    // (aggregated discovery orders by version priority), so keep the first.
    const desired = new Map<string, ResourceKindInfo>();
    const seenResource = new Set<string>();
    for (const kind of resources) {
      if (!shouldIndexKind(kind, this.multiplexed)) continue;
      const resource = `${kind.group}/${kind.plural}`;
      if (seenResource.has(resource)) continue;
      seenResource.add(resource);
      desired.set(gvrKey(kind), kind);
    }
    for (const [key, state] of this.kinds) {
      if (desired.has(key)) continue;
      this.stopKind(state);
      this.removeKindEntries(state);
      this.kinds.delete(key);
    }

    const newKinds: ResourceKindInfo[] = [];
    for (const [key, kind] of desired) {
      const existing = this.kinds.get(key);
      if (existing) {
        existing.kind = kind;
      } else {
        newKinds.push(kind);
      }
    }
    await mapWithConcurrency(newKinds, START_CONCURRENCY, async (kind) => this.startKind(kind));
  }

  private async startKind(kind: ResourceKindInfo): Promise<void> {
    if (this.disposed) return;
    const key = gvrKey(kind);
    if (this.kinds.has(key)) return;
    const state: IndexedKindState = {
      key,
      kind,
      rv: '',
      entryIds: new Set(),
      running: true,
      unavailable: false,
    };
    this.kinds.set(key, state);
    try {
      await this.relistKind(state);
    } catch (err) {
      if (!state.running || this.disposed) return;
      if (isUnavailable(err)) {
        state.unavailable = true;
        this.log.debug({ gvr: state.key, err: String(err) }, 'search index resource unavailable');
        return;
      }
      this.log.debug({ gvr: state.key, err: String(err) }, 'search index initial list failed');
    }
    void this.kindLoop(state);
  }

  private stopKind(state: IndexedKindState): void {
    state.running = false;
    state.abort?.abort();
  }

  private path(kind: ResourceKindInfo, query: URLSearchParams): string {
    return resourcePath(kind.group, kind.version, kind.plural, { query });
  }

  private async metadataJson<T>(path: string): Promise<T> {
    return this.raw.json<T>(path, { headers: { accept: METADATA_LIST_ACCEPT }, signal: this.lifecycleAbort.signal });
  }

  private async metadataStream(path: string, signal: AbortSignal, h2Required: boolean): Promise<StreamResponse> {
    // Custom-kind watches exist only because they multiplex: if the HTTP/2
    // transport disappears mid-flight they must fail (and drop to scans)
    // rather than silently fan out into hundreds of HTTP/1.1 sockets.
    return this.raw.stream(path, { headers: { accept: METADATA_WATCH_ACCEPT }, signal, h2Required });
  }

  private async listResourceMetadata(kind: ResourceKindInfo, opts?: { quorum?: boolean }): Promise<{ rv: string; items: MetadataObject[] }> {
    const items: MetadataObject[] = [];
    const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    // resourceVersion=0 lets the apiserver answer from its watch cache instead
    // of a quorum etcd read — usually the whole set in a single unpaginated
    // response (limit is ignored on the cache path; the continue loop below
    // still handles servers that fall back to paginated etcd lists).
    if (!opts?.quorum) query.set('resourceVersion', '0');
    let cursor: string | undefined;
    let rv = '';

    do {
      if (cursor) {
        query.set('continue', cursor);
        // A continue token pins the list snapshot; combining it with an
        // explicit resourceVersion is rejected by the apiserver.
        query.delete('resourceVersion');
      }
      const list = await this.metadataJson<MetadataList>(this.path(kind, query));
      rv = list.metadata?.resourceVersion ?? rv;
      cursor = list.metadata?.continue || undefined;
      items.push(...(list.items ?? []));
    } while (cursor);

    return { rv, items };
  }

  private async listKindMetadata(state: IndexedKindState, opts?: { quorum?: boolean }): Promise<{ rv: string; items: MetadataObject[] }> {
    return this.listResourceMetadata(state.kind, opts);
  }

  private async refreshCustomEntries(kinds: ResourceKindInfo[], signature: string): Promise<IndexedResourceSearchEntry[]> {
    if (this.customRefresh?.signature === signature) return this.customRefresh.promise;

    const generation = this.customGeneration;
    const promise = this.scanCustomEntries(kinds).then((entries) => {
      if (!this.disposed && generation === this.customGeneration) {
        this.customCache = { signature, refreshedAt: Date.now(), entries };
      }
      return entries;
    });
    this.customRefresh = { signature, promise };
    const clearRefresh = () => {
      if (this.customRefresh?.promise === promise) this.customRefresh = undefined;
    };
    void promise.then(clearRefresh, clearRefresh);
    return promise;
  }

  private async scanCustomEntries(kinds: ResourceKindInfo[]): Promise<IndexedResourceSearchEntry[]> {
    const entries: IndexedResourceSearchEntry[] = [];
    await mapWithConcurrency(kinds, CUSTOM_LIST_CONCURRENCY, async (kind) => {
      try {
        const { items } = await this.listResourceMetadata(kind);
        for (const item of items) {
          const metadata = item.metadata;
          if (!metadata?.name) continue;
          entries.push({
            kind,
            name: metadata.name,
            namespace: metadata.namespace,
            uid: metadata.uid,
            labelsText: labelsText(metadata.labels),
            labels: metadata.labels,
          });
        }
      } catch (err) {
        if (!this.disposed && !isAbortError(err)) {
          this.log.debug({ gvr: gvrKey(kind), err: String(err) }, 'custom resource search list failed');
        }
      }
    });
    return entries;
  }

  private replaceKindEntries(state: IndexedKindState, items: MetadataObject[]): void {
    this.removeKindEntries(state);
    for (const item of items) {
      this.upsertEntry(state, item.metadata);
    }
  }

  private removeKindEntries(state: IndexedKindState): void {
    if (state.entryIds.size) this.entriesSnapshot = undefined;
    for (const id of state.entryIds) {
      const entry = this.entriesById.get(id);
      if (entry) this.idByNameKey.delete(`${state.key}|${entry.namespace ?? ''}|${entry.name}`);
      this.entriesById.delete(id);
    }
    state.entryIds.clear();
  }

  private upsertEntry(state: IndexedKindState, metadata: Metadata | undefined): void {
    if (!metadata?.name) return;
    const id = entryId(state.key, metadata);
    const byName = nameKey(state.key, metadata);
    if (!id || !byName) return;

    const previousId = this.idByNameKey.get(byName);
    if (previousId && previousId !== id) {
      this.entriesById.delete(previousId);
      state.entryIds.delete(previousId);
    }

    this.entriesById.set(id, {
      kind: state.kind,
      name: metadata.name,
      namespace: metadata.namespace,
      uid: metadata.uid,
      labelsText: labelsText(metadata.labels),
      labels: metadata.labels,
    });
    this.idByNameKey.set(byName, id);
    state.entryIds.add(id);
    this.entriesSnapshot = undefined;
  }

  private deleteEntry(state: IndexedKindState, metadata: Metadata | undefined): void {
    if (!metadata?.name) return;
    const byName = nameKey(state.key, metadata);
    if (!byName) return;
    const id = this.idByNameKey.get(byName) ?? entryId(state.key, metadata);
    if (!id) return;
    this.idByNameKey.delete(byName);
    this.entriesById.delete(id);
    state.entryIds.delete(id);
    this.entriesSnapshot = undefined;
  }

  private async relistKind(state: IndexedKindState, opts?: { quorum?: boolean }): Promise<void> {
    const { rv, items } = await this.listKindMetadata(state, opts);
    state.rv = rv;
    this.replaceKindEntries(state, items);
  }

  private async kindLoop(state: IndexedKindState): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (state.running && !this.disposed) {
      try {
        if (!state.rv) await this.relistKind(state);
        if (state.unavailable) return;
        backoff = MIN_BACKOFF_MS;
        try {
          await this.watchKindOnce(state);
        } catch (err) {
          if (isForbidden(err)) {
            await this.listOnlyKindLoop(state);
            return;
          }
          throw err;
        }
      } catch (err) {
        if (!state.running || this.disposed) return;
        if (err instanceof H2UnavailableError) {
          // The multiplexed transport is gone (proxy or LB change). Drop this
          // custom watch and reconcile: the re-probe demotes every custom kind
          // to the scan path instead of retrying into per-watch sockets.
          this.log.debug({ gvr: state.key }, 'search index lost multiplexed transport, falling back to scans');
          this.stopKind(state);
          this.removeKindEntries(state);
          this.kinds.delete(state.key);
          void this.reconcileKinds();
          return;
        }
        if (isUnavailable(err)) {
          state.unavailable = true;
          this.removeKindEntries(state);
          this.log.debug({ gvr: state.key, err: String(err) }, 'search index resource unavailable');
          return;
        }
        if (isGone(err)) {
          try {
            // After a 410 the watch cache itself may be behind the RV we
            // already saw — re-anchor with a quorum list (client-go does the same).
            await this.relistKind(state, { quorum: true });
            continue;
          } catch (relistErr) {
            this.log.debug({ gvr: state.key, err: String(relistErr) }, 'search index relist failed');
          }
        } else {
          this.log.debug({ gvr: state.key, err: String(err) }, 'search index watch failed');
        }
        if (!(await this.waitForRetry(backoff))) return;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async listOnlyKindLoop(state: IndexedKindState): Promise<void> {
    this.log.debug({ gvr: state.key }, 'search index watch forbidden, falling back to periodic relist');
    while (state.running && !this.disposed) {
      if (!(await this.waitForRetry(WATCH_FORBIDDEN_RELIST_MS))) return;
      if (!state.running || this.disposed) return;
      try {
        await this.relistKind(state);
      } catch (err) {
        if (!state.running || this.disposed) return;
        if (isUnavailable(err)) {
          state.unavailable = true;
          this.removeKindEntries(state);
          this.log.debug({ gvr: state.key, err: String(err) }, 'search index resource unavailable');
          return;
        }
        this.log.debug({ gvr: state.key, err: String(err) }, 'search index periodic relist failed');
      }
    }
  }

  private async waitForRetry(ms: number): Promise<boolean> {
    try {
      await delay(ms, undefined, { signal: this.lifecycleAbort.signal, ref: false });
      return !this.disposed;
    } catch (err) {
      if (isAbortError(err)) return false;
      throw err;
    }
  }

  private async watchKindOnce(state: IndexedKindState): Promise<void> {
    state.abort = new AbortController();
    const query = new URLSearchParams({
      watch: '1',
      resourceVersion: state.rv,
      allowWatchBookmarks: 'true',
      timeoutSeconds: '300',
    });
    const res = await this.metadataStream(this.path(state.kind, query), state.abort.signal, state.kind.custom === true);
    const body = res.body;
    if (!body) throw new Error('watch response had no body');

    let buffer = '';
    for await (const chunk of body) {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        this.processKindWatchLine(state, JSON.parse(line) as WatchLine);
      }
    }
  }

  private processKindWatchLine(state: IndexedKindState, event: WatchLine): void {
    if (event.type === 'ERROR') {
      const code = event.object?.code;
      if (code === 410) throw apiException(410, event.object?.message ?? '410 Gone', event.object);
      throw new Error(`watch error: ${event.object?.message ?? 'unknown'}`);
    }

    const metadata = event.object?.metadata;
    const rv = metadata?.resourceVersion;
    if (rv) state.rv = rv;
    if (event.type === 'BOOKMARK') return;
    if (event.type === 'DELETED') this.deleteEntry(state, metadata);
    else this.upsertEntry(state, metadata);
  }

}
