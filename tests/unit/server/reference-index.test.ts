import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { KubeObject } from '@kubus/shared';
import type { RawClient } from '../../../server/src/kube/raw-client.js';
import { ReferenceIndex } from '../../../server/src/kube/reference-index.js';

// The watcher backs off with node:timers/promises setTimeout; resolve it at once.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => {}) };
});

/** A raw client whose lists are scripted per path and whose watches stay open until aborted. */
class FakeRaw {
  jsonCalls: string[] = [];
  private lists = new Map<string, () => Promise<unknown>>();

  list(pathPrefix: string, respond: () => Promise<unknown>): void {
    this.lists.set(pathPrefix, respond);
  }

  json(path: string): Promise<unknown> {
    this.jsonCalls.push(path);
    for (const [prefix, respond] of this.lists) if (path.startsWith(prefix)) return respond();
    return new Promise(() => {});
  }

  stream(_path: string, init: { signal: AbortSignal }): Promise<{ body: AsyncIterable<Buffer> }> {
    // A watch that yields nothing and fails only when aborted.
    const body: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Buffer>>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          }),
      }),
    };
    return Promise.resolve({ body });
  }

  asClient(): RawClient {
    return this as unknown as RawClient;
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: (): unknown => log } as unknown as FastifyBaseLogger;

const LINKS = { group: 'core.example.com', version: 'v1', plural: 'topolinks', kind: 'TopoLink', namespaced: true };

function link(name: string, node: string, extra: Record<string, unknown> = {}): KubeObject {
  return { metadata: { name, namespace: 'eda', uid: `u-${name}`, resourceVersion: '1', labels: { tier: 'leaf' } }, spec: { links: [{ local: { node, speed: '100G' } }], ...extra }, status: { health: 'up' } };
}

const indexes: ReferenceIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.stopAll();
});

describe('ReferenceIndex', () => {
  it('lists a kind once from the watch cache, keeps only kind-naming fields, and answers later lookups from memory', async () => {
    const raw = new FakeRaw();
    raw.list('/apis/core.example.com/v1/topolinks', async () => ({ metadata: { resourceVersion: '5' }, items: [link('a', 'l001'), link('b', 'l002', { secretRef: { name: 'db' } })] }));
    const index = new ReferenceIndex(raw.asClient(), log);
    indexes.push(index);
    index.setVocabulary(['TopoNode', 'Secret']);

    const first = await index.lookup(LINKS);
    expect(first).toMatchObject({ ready: true, unavailable: false });
    expect(first.entries.map((e) => [e.name, e.namespace, e.labels, e.digest])).toEqual([
      ['a', 'eda', { tier: 'leaf' }, { hints: [{ path: 'spec.links[0].local.node', value: 'l001' }], selectors: [] }],
      ['b', 'eda', { tier: 'leaf' }, { hints: [{ path: 'spec.links[0].local.node', value: 'l002' }, { path: 'spec.secretRef.name', value: 'db' }], selectors: [] }],
    ]);
    expect(raw.jsonCalls).toEqual(['/apis/core.example.com/v1/topolinks?limit=1000&resourceVersion=0']);
    expect(index.isWarm(LINKS)).toBe(true);

    const second = await index.lookup(LINKS);
    expect(second.entries).toHaveLength(2);
    expect(raw.jsonCalls).toHaveLength(1);
  });

  it('returns not-ready past the deadline while the list keeps running, then serves it', async () => {
    const raw = new FakeRaw();
    let release!: () => void;
    raw.list('/apis/core.example.com/v1/topolinks', () => new Promise((resolve) => {
      release = () => resolve({ metadata: { resourceVersion: '5' }, items: [link('a', 'l001')] });
    }));
    const index = new ReferenceIndex(raw.asClient(), log);
    indexes.push(index);
    index.setVocabulary(['TopoNode']);

    const early = await index.lookup(LINKS, { deadline: Date.now() + 20 });
    expect(early).toEqual({ entries: [], ready: false, unavailable: false });
    release();
    const later = await index.lookup(LINKS, { deadline: Date.now() + 1000 });
    expect(later.ready).toBe(true);
    expect(later.entries.map((e) => e.name)).toEqual(['a']);
    expect(raw.jsonCalls).toHaveLength(1);
  });

  it('marks kinds it may not read as unavailable and forgets them', async () => {
    const raw = new FakeRaw();
    raw.list('/apis/core.example.com/v1/topolinks', async () => {
      throw Object.assign(new Error('forbidden'), { code: 403 });
    });
    const index = new ReferenceIndex(raw.asClient(), log);
    indexes.push(index);
    expect(await index.lookup(LINKS)).toEqual({ entries: [], ready: true, unavailable: true });
    expect(index.isWarm(LINKS)).toBe(false);
  });

  it('drops what it holds when the vocabulary grows, since older digests missed the new kinds', async () => {
    const raw = new FakeRaw();
    raw.list('/apis/core.example.com/v1/topolinks', async () => ({ metadata: { resourceVersion: '5' }, items: [link('a', 'l001', { secretRef: { name: 'db' } })] }));
    const index = new ReferenceIndex(raw.asClient(), log);
    indexes.push(index);
    index.setVocabulary(['TopoNode']);
    expect((await index.lookup(LINKS)).entries[0]?.digest.hints.map((h) => h.path)).toEqual(['spec.links[0].local.node']);
    index.setVocabulary(['TopoNode']);
    expect(index.isWarm(LINKS)).toBe(true);
    index.setVocabulary(['TopoNode', 'Secret']);
    expect(index.isWarm(LINKS)).toBe(false);
    expect((await index.lookup(LINKS)).entries[0]?.digest.hints.map((h) => h.path)).toEqual(['spec.links[0].local.node', 'spec.secretRef.name']);
    expect(raw.jsonCalls).toHaveLength(2);
  });
});
