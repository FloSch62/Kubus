import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Response } from 'node-fetch';
import { ApiException } from '@kubernetes/client-node';
import { BUILTIN_NAV_GROUPS, type ResourceKindInfo, type WatchEventType } from '@kubus/shared';
import type { DiscoveryCache } from './discovery.js';
import { resourcePath, type RawClient } from './raw-client.js';

const LIST_PAGE_SIZE = 1_000;
const START_CONCURRENCY = 16;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const WATCH_FORBIDDEN_RELIST_MS = 60_000;
const CRD_RECONCILE_DEBOUNCE_MS = 1_000;
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

function shouldIndexKind(kind: ResourceKindInfo): boolean {
  if (!kind.verbs.includes('list') || !kind.verbs.includes('watch')) return false;
  return !!kind.custom || BUILTIN_RESOURCE_SEARCH_KINDS.has(gvrKey(kind));
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
 * Live, names-only search index.
 *
 * The index does one metadata-only LIST per searchable GVR, then keeps that
 * GVR current with a metadata watch. Search reads the in-memory entries and
 * never triggers full scans. If a watch expires with 410, only that GVR is
 * relisted. CRD changes invalidate discovery and reconcile the watched GVR set.
 */
export class ResourceSearchIndex {
  private entriesById = new Map<string, IndexedResourceSearchEntry>();
  /** Snapshot of entriesById.values(), rebuilt lazily after mutations. */
  private entriesSnapshot?: IndexedResourceSearchEntry[];
  private idByNameKey = new Map<string, string>();
  private kinds = new Map<string, IndexedKindState>();
  private started = false;
  private disposed = false;
  private reconcileInFlight?: Promise<void>;
  private reconcileTimer?: NodeJS.Timeout;
  private safetyReconcileTimer?: NodeJS.Timeout;
  private crdAbort?: AbortController;
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
    this.startCrdWatch();
    this.safetyReconcileTimer = setInterval(() => this.scheduleReconcile(true), DISCOVERY_SAFETY_RECONCILE_MS);
    this.safetyReconcileTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleAbort.abort();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    if (this.safetyReconcileTimer) clearInterval(this.safetyReconcileTimer);
    this.crdAbort?.abort();
    for (const state of this.kinds.values()) this.stopKind(state);
    this.kinds.clear();
    this.entriesById.clear();
    this.entriesSnapshot = undefined;
    this.idByNameKey.clear();
  }

  /** Shared snapshot — callers must not mutate the returned array. */
  async entries(): Promise<IndexedResourceSearchEntry[]> {
    this.warm();
    this.entriesSnapshot ??= [...this.entriesById.values()];
    return this.entriesSnapshot;
  }

  isReconciling(): boolean {
    this.warm();
    return !!this.reconcileInFlight;
  }

  private scheduleReconcile(invalidateDiscovery: boolean): void {
    if (this.disposed) return;
    if (invalidateDiscovery) this.discovery.invalidate();
    if (this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcileKinds();
    }, CRD_RECONCILE_DEBOUNCE_MS);
    this.reconcileTimer.unref();
  }

  private async reconcileKinds(): Promise<void> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    this.reconcileInFlight = this.reconcileKindsNow().finally(() => {
      this.reconcileInFlight = undefined;
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

    // Every served version of a resource exposes the same objects, so index
    // one version per group/plural. Discovery lists versions preferred-first
    // (aggregated discovery orders by version priority), so keep the first.
    const desired = new Map<string, ResourceKindInfo>();
    const seenResource = new Set<string>();
    for (const kind of resources) {
      if (!shouldIndexKind(kind)) continue;
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

  private async metadataStream(path: string, signal: AbortSignal): Promise<Response> {
    const res = await this.raw.request(path, { headers: { accept: METADATA_WATCH_ACCEPT }, signal });
    if (!res.ok) {
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : `watch failed: ${res.status} ${res.statusText}`;
      throw apiException(res.status, message, body);
    }
    return res;
  }

  private async listKindMetadata(state: IndexedKindState, opts?: { quorum?: boolean }): Promise<{ rv: string; items: MetadataObject[] }> {
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
      const list = await this.metadataJson<MetadataList>(this.path(state.kind, query));
      rv = list.metadata?.resourceVersion ?? rv;
      cursor = list.metadata?.continue || undefined;
      items.push(...(list.items ?? []));
    } while (cursor);

    return { rv, items };
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
    const res = await this.metadataStream(this.path(state.kind, query), state.abort.signal);
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

  private startCrdWatch(): void {
    void this.crdWatchLoop();
  }

  private async listCrdResourceVersion(): Promise<string> {
    const query = new URLSearchParams({ limit: '1' });
    const list = await this.metadataJson<MetadataList>(resourcePath('apiextensions.k8s.io', 'v1', 'customresourcedefinitions', { query }));
    return list.metadata?.resourceVersion ?? '';
  }

  private async crdWatchLoop(): Promise<void> {
    let rv = '';
    let backoff = MIN_BACKOFF_MS;
    while (!this.disposed) {
      try {
        if (!rv) rv = await this.listCrdResourceVersion();
        this.crdAbort = new AbortController();
        const query = new URLSearchParams({
          watch: '1',
          resourceVersion: rv,
          allowWatchBookmarks: 'true',
          timeoutSeconds: '300',
        });
        const path = resourcePath('apiextensions.k8s.io', 'v1', 'customresourcedefinitions', { query });
        const res = await this.metadataStream(path, this.crdAbort.signal);
        const body = res.body;
        if (!body) throw new Error('CRD watch response had no body');
        backoff = MIN_BACKOFF_MS;

        let buffer = '';
        for await (const chunk of body) {
          buffer += chunk.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const event = JSON.parse(line) as WatchLine;
            if (event.type === 'ERROR') {
              if (event.object?.code === 410) throw apiException(410, event.object?.message ?? '410 Gone', event.object);
              throw new Error(`CRD watch error: ${event.object?.message ?? 'unknown'}`);
            }
            const nextRv = event.object?.metadata?.resourceVersion;
            if (nextRv) rv = nextRv;
            if (event.type !== 'BOOKMARK') this.scheduleReconcile(true);
          }
        }
      } catch (err) {
        if (this.disposed) return;
        if (isGone(err)) {
          rv = '';
          this.scheduleReconcile(true);
          continue;
        }
        if (isUnavailable(err)) return;
        this.log.debug({ err: String(err) }, 'search index CRD watch failed');
        if (!(await this.waitForRetry(backoff))) return;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }
}
