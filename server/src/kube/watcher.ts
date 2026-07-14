import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { KubeObject, WatchEventType, WatchStatusState } from '@kubus/shared';
import { RawClient, isRetryableTransportError, resourcePath } from './raw-client.js';

export interface WatcherDelta {
  type: WatchEventType;
  object: KubeObject;
}

export interface WatcherSubscriber {
  onDeltas(deltas: WatcherDelta[]): void;
  onStatus(state: WatchStatusState, message?: string): void;
}

interface WatchLine {
  type: WatchEventType | 'BOOKMARK' | 'ERROR';
  object: KubeObject & { code?: number; message?: string };
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const RETRYABLE_LIST_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Generic list+watch for one (gvr, namespace) on one cluster. Maintains an
 * in-memory cache keyed by uid, tracks resourceVersion (incl. bookmarks),
 * reconnects with backoff, and recovers from 410 Gone by relisting and
 * synthesizing deltas so subscribers never have to refetch.
 */
export class ResourceWatcher {
  private cache = new Map<string, KubeObject>();
  private rv = '';
  private subscribers = new Set<WatcherSubscriber>();
  private abort?: AbortController;
  private running = false;
  private unavailable = false;
  private initialList?: Promise<void>;
  private state: WatchStatusState = 'reconnecting';

  constructor(
    private raw: RawClient,
    public readonly group: string,
    public readonly version: string,
    public readonly plural: string,
    public readonly namespace: string | undefined,
    private log: FastifyBaseLogger,
  ) {}

  /** Resolves once the initial LIST populated the cache. */
  ready(): Promise<void> {
    if (!this.running) this.start();
    if (!this.initialList) {
      const pending = this.listUntilReady();
      this.initialList = pending;
      // A stop or other terminal failure must not poison a later start with a
      // permanently rejected cached promise.
      void pending.catch(() => {
        if (this.initialList === pending) this.initialList = undefined;
      });
    }
    return this.initialList;
  }

  snapshot(): { items: KubeObject[]; resourceVersion: string } {
    return { items: [...this.cache.values()], resourceVersion: this.rv };
  }

  /** Current cached objects — used by the overview aggregator. */
  items(): KubeObject[] {
    return [...this.cache.values()];
  }

  currentState(): WatchStatusState {
    return this.state;
  }

  subscribe(sub: WatcherSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  start(): void {
    if (this.running || this.unavailable) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private emitDeltas(deltas: WatcherDelta[]): void {
    if (!deltas.length) return;
    for (const sub of this.subscribers) {
      try {
        sub.onDeltas(deltas);
      } catch (err) {
        this.log.warn({ err }, 'watch subscriber failed');
      }
    }
  }

  private setState(state: WatchStatusState, message?: string): void {
    if (this.state === state) return;
    this.state = state;
    for (const sub of this.subscribers) {
      try {
        sub.onStatus(state, message);
      } catch {
        /* subscriber gone */
      }
    }
  }

  private markUnavailable(err: unknown): void {
    const old = [...this.cache.values()];
    this.cache.clear();
    this.rv = '';
    this.unavailable = true;
    this.running = false;
    this.abort?.abort();
    this.emitDeltas(old.map((object) => ({ type: 'DELETED', object })));
    this.setState('unavailable', missingResourceMessage(this.group, this.version, this.plural, err));
  }

  private path(query: URLSearchParams): string {
    return resourcePath(this.group, this.version, this.plural, { namespace: this.namespace || undefined, query });
  }

  /**
   * Keep initial readiness pending across transient LIST failures. This lets
   * subscribers survive an API connection reset and guarantees every retry is
   * a fresh request instead of another await of the same rejected promise.
   */
  private async listUntilReady(): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (this.running) {
      try {
        await this.listInto(this.cache);
        return;
      } catch (err) {
        if (!this.running) throw err;
        if (isUnavailable(err)) {
          this.markUnavailable(err);
          return;
        }
        if (!isRetryableListError(err)) throw err;
        this.setState('reconnecting', err instanceof Error ? err.message : String(err));
        await delay(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
    throw new Error('watcher stopped before its initial list completed');
  }

  private async listInto(target: Map<string, KubeObject>): Promise<string> {
    const query = new URLSearchParams({ limit: '1000' });
    let continueToken: string | undefined;
    let rv = '';
    target.clear();
    do {
      if (continueToken) query.set('continue', continueToken);
      const list = await this.raw.json<{ metadata?: { resourceVersion?: string; continue?: string }; items?: KubeObject[] }>(this.path(query));
      rv = list.metadata?.resourceVersion ?? rv;
      continueToken = list.metadata?.continue || undefined;
      for (const item of list.items ?? []) {
        prepare(item, this.group, this.version);
        target.set(item.metadata.uid, item);
      }
    } while (continueToken);
    this.rv = rv;
    return rv;
  }

  private async loop(): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (this.running) {
      try {
        if (!this.rv) {
          await this.ready();
        }
        if (this.unavailable) break;
        this.setState('live');
        backoff = MIN_BACKOFF_MS;
        await this.watchOnce();
      } catch (err) {
        if (!this.running) break;
        if (isUnavailable(err)) {
          this.log.info({ gvr: `${this.group}/${this.version}/${this.plural}` }, 'resource API unavailable, stopping watch');
          this.markUnavailable(err);
          break;
        }
        const gone = isGone(err);
        if (gone) {
          this.log.info({ gvr: `${this.group}/${this.version}/${this.plural}` }, 'watch expired (410), relisting');
          try {
            await this.relistAndDiff();
            continue;
          } catch (relistErr) {
            this.setState('error', String(relistErr));
          }
        } else {
          this.setState('reconnecting', err instanceof Error ? err.message : String(err));
        }
        await delay(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** One watch connection; returns normally on benign close, throws on errors. */
  private async watchOnce(): Promise<void> {
    this.abort = new AbortController();
    const query = new URLSearchParams({
      watch: '1',
      resourceVersion: this.rv,
      allowWatchBookmarks: 'true',
      timeoutSeconds: '300',
    });
    const res = await this.raw.stream(this.path(query), this.abort.signal);
    const body = res.body;
    if (!body) throw new Error('watch response had no body');

    let buffer = '';
    for await (const chunk of body) {
      buffer += chunk.toString('utf8');
      let nl: number;
      const deltas: WatcherDelta[] = [];
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line) as WatchLine;
        if (event.type === 'ERROR') {
          const code = (event.object as { code?: number }).code;
          if (code === 410) throw new GoneError();
          throw new Error(`watch error: ${(event.object as { message?: string }).message ?? 'unknown'}`);
        }
        const obj = event.object;
        const newRv = obj.metadata?.resourceVersion;
        if (newRv) this.rv = newRv;
        if (event.type === 'BOOKMARK') continue;
        prepare(obj, this.group, this.version);
        if (event.type === 'DELETED') {
          this.cache.delete(obj.metadata.uid);
        } else {
          this.cache.set(obj.metadata.uid, obj);
        }
        deltas.push({ type: event.type, object: obj });
      }
      this.emitDeltas(deltas);
    }
    // Stream ended (server-side timeout) — normal; loop reconnects from rv.
  }

  /** After 410: full relist, diff against old cache, emit synthetic deltas. */
  private async relistAndDiff(): Promise<void> {
    const old = this.cache;
    const fresh = new Map<string, KubeObject>();
    await this.listInto(fresh);
    const deltas: WatcherDelta[] = [];
    for (const [uid, obj] of fresh) {
      const prev = old.get(uid);
      if (!prev) {
        deltas.push({ type: 'ADDED', object: obj });
      } else if (prev.metadata.resourceVersion !== obj.metadata.resourceVersion) {
        deltas.push({ type: 'MODIFIED', object: obj });
      }
    }
    for (const [uid, obj] of old) {
      if (!fresh.has(uid)) deltas.push({ type: 'DELETED', object: obj });
    }
    this.cache = fresh;
    this.emitDeltas(deltas);
    this.setState('live');
  }
}

class GoneError extends Error {
  readonly gone = true;
  constructor() {
    super('410 Gone');
  }
}

function isGone(err: unknown): boolean {
  if (err instanceof GoneError) return true;
  const code = (err as { code?: number })?.code;
  return code === 410;
}

function isUnavailable(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === 404;
}

function isRetryableListError(err: unknown): boolean {
  if (isRetryableTransportError(err)) return true;
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' && RETRYABLE_LIST_STATUS_CODES.has(code);
}

function missingResourceMessage(group: string, version: string, plural: string, err: unknown): string {
  const gvr = `${group ? `${group}/` : ''}${version}/${plural}`;
  const bodyMessage =
    typeof (err as { body?: { message?: unknown } })?.body?.message === 'string'
      ? String((err as { body: { message: unknown } }).body.message)
      : undefined;
  if (bodyMessage && bodyMessage !== '404 page not found') return bodyMessage;
  return `Resource API ${gvr} is not installed on this cluster.`;
}

/** Normalize objects before caching: drop managedFields, fill kind/apiVersion. */
function prepare(obj: KubeObject, group: string, version: string): void {
  if (obj.metadata && 'managedFields' in obj.metadata) {
    delete (obj.metadata as Record<string, unknown>).managedFields;
  }
  obj.apiVersion ??= group ? `${group}/${version}` : version;
}

/** Ref-counted registry of watchers for one cluster, with stop-linger. */
export class WatcherRegistry {
  private watchers = new Map<string, { watcher: ResourceWatcher; refs: number; linger?: NodeJS.Timeout }>();

  constructor(
    private raw: RawClient,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Acquire a shared watcher. Returns the watcher and a release function.
   * `pin: true` (overview watchers) acquires without intent to release.
   */
  acquire(group: string, version: string, plural: string, namespace?: string): { watcher: ResourceWatcher; release: () => void } {
    const key = `${group}/${version}/${plural}/${namespace ?? ''}`;
    let entry = this.watchers.get(key);
    if (!entry) {
      entry = { watcher: new ResourceWatcher(this.raw, group, version, plural, namespace, this.log), refs: 0 };
      this.watchers.set(key, entry);
    }
    if (entry.linger) {
      clearTimeout(entry.linger);
      entry.linger = undefined;
    }
    entry.refs++;
    entry.watcher.start();
    let released = false;
    const release = () => {
      if (released || !entry) return;
      released = true;
      entry.refs--;
      if (entry.refs <= 0) {
        entry.linger = setTimeout(() => {
          entry.watcher.stop();
          this.watchers.delete(key);
        }, 30_000);
        entry.linger.unref();
      }
    };
    return { watcher: entry.watcher, release };
  }

  /** Peek at an existing watcher's cache without acquiring (overview). */
  peek(group: string, version: string, plural: string, namespace?: string): ResourceWatcher | undefined {
    return this.watchers.get(`${group}/${version}/${plural}/${namespace ?? ''}`)?.watcher;
  }

  stopAll(): void {
    for (const entry of this.watchers.values()) {
      if (entry.linger) clearTimeout(entry.linger);
      entry.watcher.stop();
    }
    this.watchers.clear();
  }
}
