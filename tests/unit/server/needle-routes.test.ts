import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { ApiException } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import type { AppContext } from '../../../server/src/app';
import { registerNeedleRoutes } from '../../../server/src/routes/needle';
import { PodObservations } from '../../../server/src/kube/pod-observations';
import type { ResourceWatcher, WatcherSubscriber } from '../../../server/src/kube/watcher';

const pod: KubeObject = { metadata: { name: 'api', namespace: 'prod', uid: 'uid-1' }, spec: { containers: [{ name: 'app' }] },
  status: { containerStatuses: [{ name: 'app', lastState: { terminated: { exitCode: 137, reason: 'OOMKilled', finishedAt: '2026-09-20T12:00:00Z' } } }] } };
const url = '/api/contexts/test/detail/pod-logs?namespace=prod&name=api&uid=uid-1&container=app&previous=true';

describe('metadata-only inventories', () => {
  it('negotiates metadata, preserves pagination and strips any unexpected payload or annotations', async () => {
    const json = vi.fn(async (_path: string, _options?: unknown) => ({ metadata: { continue: 'next-page' }, items: [{
      metadata: { name: 'database', namespace: 'prod', uid: 'secret-1', labels: { app: 'database' }, annotations: { 'kubectl.kubernetes.io/last-applied-configuration': 'sensitive' } },
      data: { password: 'sensitive' }, stringData: { password: 'sensitive' },
    }] }));
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get: () => ({ raw: { json } }) } } as unknown as AppContext);
    try {
      const response = await app.inject('/api/contexts/test/detail/resource-metadata/secrets?namespace=prod&limit=1000&continue=opaque');
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('sensitive');
      expect(response.json().continue).toBe('next-page');
      expect(response.json().items[0].metadata.name).toBe('database');
      expect(json.mock.calls[0]?.[0]).toBe('/api/v1/namespaces/prod/secrets?limit=1000&continue=opaque');
      expect(json.mock.calls[0]?.[1]).toEqual({ headers: { Accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1' } });
    } finally { await app.close(); }
  });
  it.each([403, 406])('does not fall back to full objects on HTTP %s', async (code) => {
    const json = vi.fn(async () => { throw new ApiException(code, 'Unavailable', {}, {}); });
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get: () => ({ raw: { json } }) } } as unknown as AppContext);
    try {
      expect((await app.inject('/api/contexts/test/detail/resource-metadata/secrets')).statusCode).toBe(code);
      expect(json).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it('validates resource, namespace and page size before contacting Kubernetes', async () => {
    const get = vi.fn();
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get } } as unknown as AppContext);
    try {
      for (const suffix of ['pods', 'secrets?namespace=..', 'secrets?limit=1001', 'configmaps?limit=0']) expect((await app.inject('/api/contexts/test/detail/resource-metadata/' + suffix)).statusCode).toBe(422);
      expect(get).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe('bounded diagnosis reads', () => {
  it('bounds log bytes, checks UID before and after reading, and never follows', async () => {
    const raw = { json: vi.fn(async () => pod), stream: vi.fn(async (_path: string) => ({ body: Readable.from(['x'.repeat(20_000)]) })) };
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get: () => ({ raw }) } } as unknown as AppContext);
    try {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      expect(response.json().text).toHaveLength(16384);
      expect(response.json().truncated).toBe(true);
      expect(raw.json).toHaveBeenCalledTimes(2);
      expect(raw.stream.mock.calls[0]?.[0]).toContain('follow=false');
      expect(raw.stream.mock.calls[0]?.[0]).toContain('tailLines=80');
    } finally { await app.close(); }
  });
  it.each([false, true])('rejects a replacement %s during the log request', async (during) => {
    let reads = 0;
    const raw = { json: vi.fn(async () => ({ ...pod, metadata: { ...pod.metadata, uid: ++reads === 1 && during ? 'uid-1' : 'replacement' } })), stream: vi.fn(async () => ({ body: Readable.from(['wrong']) })) };
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get: () => ({ raw }) } } as unknown as AppContext);
    try {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(409);
      if (!during) expect(raw.stream).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rechecks pod list permissions before returning historical facts', async () => {
    const snapshot = vi.fn();
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get: () => ({ raw: { json: async () => { throw new ApiException(403, 'Forbidden', {}, {}); } }, podObservations: { snapshot } }) } } as unknown as AppContext);
    try {
      const response = await app.inject('/api/contexts/test/observations/terminations?namespace=prod');
      expect(response.statusCode).toBe(403);
      expect(snapshot).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rejects malformed log targets before making an API request', async () => {
    const get = vi.fn();
    const app = Fastify();
    registerNeedleRoutes(app, { clusters: { get } } as unknown as AppContext);
    try {
      expect((await app.inject(url.replace('name=api', 'name=..'))).statusCode).toBe(422);
      expect((await app.inject(url.replace('previous=true', 'previous=anything'))).statusCode).toBe(422);
      expect(get).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe('termination observation journal', () => {
  it('deduplicates status observations, preserves deleted pods and never invents a deletion time', async () => {
    let subscriber: WatcherSubscriber | undefined;
    const watcher = { subscribe: (sub: WatcherSubscriber) => { subscriber = sub; return () => {}; }, ready: async () => {}, items: () => [pod], currentState: () => 'live' } as unknown as ResourceWatcher;
    const journal = new PodObservations();
    journal.start(watcher);
    await Promise.resolve();
    subscriber!.onDeltas([{ type: 'MODIFIED', object: pod }, { type: 'DELETED', object: pod }]);
    subscriber!.onDeltas([{ type: 'DELETED', object: { metadata: { name: 'no-status', uid: 'no-status', namespace: 'prod' } } }]);
    const snapshot = journal.snapshot('prod');
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.finishedAt).toBe('2026-09-20T12:00:00Z');
    expect(journal.snapshot('other').items).toHaveLength(0);
    subscriber!.onStatus('reconnecting');
    expect(journal.snapshot().interrupted).toBe(true);
    journal.stop();
  });
  it('evicts by capacity and observation age, including deleted identities', () => {
    const journal = new PodObservations(1, 1000);
    journal.observe(pod, 10_000);
    journal.observe({ ...pod, metadata: { ...pod.metadata, uid: 'new' } }, 10_001);
    expect(journal.snapshot(undefined, 10_002).items.map((entry) => entry.uid)).toEqual(['new']);
    expect(journal.snapshot(undefined, 11_002).items).toHaveLength(0);
    expect(journal.snapshot(undefined, 11_002).evicted).toBe(2);
  });
});
