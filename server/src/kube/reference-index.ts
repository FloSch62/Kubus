import type { FastifyBaseLogger } from 'fastify';
import type { KubeObject } from '@kubus/shared';
import type { RawClient } from './raw-client.js';
import { createPathFilter, digestObject, kindVocabulary, type ReferenceDigest } from './relation-hints.js';
import { ResourceWatcher } from './watcher.js';

/**
 * Live digests of custom kinds, built on demand for reverse-reference
 * lookups ("who points at this TopoNode"). The first lookup of a kind lists
 * it once from the API server's watch cache and keeps a watch open; every
 * later lookup, for any target, answers from memory. Objects are reduced to
 * the fields that can name a kind (plus selectors and labels) as they
 * arrive, so a 16k-object kind costs a few megabytes rather than a copy of
 * every status block. Kinds nobody asked about for a while are dropped.
 */

export interface IndexedKindSpec {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

export interface DigestEntry {
  name: string;
  namespace?: string;
  uid: string;
  labels?: Record<string, string>;
  digest: ReferenceDigest;
}

export interface DigestLookup {
  entries: DigestEntry[];
  /** False when the initial list is still running past the caller's deadline; entries are then empty. */
  ready: boolean;
  /** The kind cannot be read (RBAC or not served). */
  unavailable: boolean;
}

interface Held {
  spec: IndexedKindSpec;
  watcher: ResourceWatcher;
  lastUsed: number;
}

interface DigestObject extends KubeObject {
  digest: ReferenceDigest;
}

const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_KINDS = 64;

function key(spec: IndexedKindSpec): string {
  return `${spec.group}/${spec.version}/${spec.plural}`;
}

export class ReferenceIndex {
  private held = new Map<string, Held>();
  private namesKind = createPathFilter(new Set());
  private vocabulary = new Set<string>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    private raw: RawClient,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * The kinds whose references are worth keeping. Digests only retain fields
   * that name one of these, so a vocabulary that grows (a CRD was installed)
   * invalidates what was built with the smaller one.
   */
  setVocabulary(kinds: Iterable<string>): void {
    const next = kindVocabulary(kinds);
    const grew = [...next].some((term) => !this.vocabulary.has(term));
    if (grew && this.held.size) this.stopAll();
    if (grew || next.size !== this.vocabulary.size) {
      this.vocabulary = next;
      this.namesKind = createPathFilter(next);
    }
  }

  /** Whether a kind is already indexed and live, i.e. a lookup would be free. */
  isWarm(spec: IndexedKindSpec): boolean {
    return this.held.get(key(spec))?.watcher.currentState() === 'live';
  }

  /**
   * Digests of one kind, building the index on first use. Waits for the
   * initial list until `deadline`; past it the build keeps running in the
   * background and the result says `ready: false`.
   */
  async lookup(spec: IndexedKindSpec, opts: { deadline?: number } = {}): Promise<DigestLookup> {
    const held = this.acquire(spec);
    held.lastUsed = Date.now();
    const unready: DigestLookup = { entries: [], ready: false, unavailable: false };
    try {
      const ready = await this.withDeadline(held.watcher.ready(), opts.deadline);
      if (!ready) return unready;
    } catch (err) {
      this.log.debug({ gvr: key(spec), err: String(err) }, 'reference index list failed');
      this.drop(key(spec));
      return { ...unready, ready: true, unavailable: true };
    }
    if (held.watcher.currentState() === 'unavailable') {
      this.drop(key(spec));
      return { ...unready, ready: true, unavailable: true };
    }
    return { entries: held.watcher.items().map((obj) => toEntry(obj as DigestObject)), ready: true, unavailable: false };
  }

  stopAll(): void {
    for (const id of this.held.keys()) this.drop(id);
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private acquire(spec: IndexedKindSpec): Held {
    const id = key(spec);
    let held = this.held.get(id);
    if (held) return held;
    if (this.held.size >= MAX_KINDS) {
      const oldest = [...this.held.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) this.drop(oldest[0]);
    }
    const namesKind = this.namesKind;
    const watcher = new ResourceWatcher(this.raw, spec.group, spec.version, spec.plural, undefined, this.log, {
      project: (obj) => projectDigest(obj, namesKind),
      listFromWatchCache: true,
      unavailableStatusCodes: [403, 404],
    });
    held = { spec, watcher, lastUsed: Date.now() };
    this.held.set(id, held);
    watcher.start();
    this.ensureSweeper();
    return held;
  }

  private drop(id: string): void {
    const held = this.held.get(id);
    if (!held) return;
    held.watcher.stop();
    this.held.delete(id);
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - IDLE_MS;
      for (const [id, held] of this.held) if (held.lastUsed < cutoff) this.drop(id);
      if (!this.held.size && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  private async withDeadline(ready: Promise<void>, deadline: number | undefined): Promise<boolean> {
    if (deadline === undefined) {
      await ready;
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
      timer.unref();
    });
    try {
      return await Promise.race([ready.then(() => true as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** The slim object the watcher caches: metadata plus the digest, nothing else. */
function projectDigest(obj: KubeObject, namesKind: (path: string) => boolean): KubeObject {
  const projected: DigestObject = {
    apiVersion: obj.apiVersion,
    kind: obj.kind,
    metadata: {
      name: obj.metadata.name,
      namespace: obj.metadata.namespace,
      uid: obj.metadata.uid,
      resourceVersion: obj.metadata.resourceVersion,
      labels: obj.metadata.labels,
    },
    digest: digestObject(obj, namesKind),
  };
  return projected;
}

function toEntry(obj: DigestObject): DigestEntry {
  return { name: obj.metadata.name, namespace: obj.metadata.namespace, uid: obj.metadata.uid, labels: obj.metadata.labels, digest: obj.digest };
}
