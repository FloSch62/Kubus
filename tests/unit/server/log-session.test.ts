import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LOG_SOCKET_COMPLETE_CODE, LOG_SOCKET_NO_STREAMS_CODE, type KubeObject } from '@kubus/shared';
import type { AppContext } from '../../../server/src/app.js';
import type { WatcherSubscriber } from '../../../server/src/kube/watcher.js';
import { containerRun } from '../../../server/src/ws/log-session.js';
import { registerLogsSocket } from '../../../server/src/ws/logs-socket.js';

type Handler = (a: unknown, b: unknown) => unknown;
type Frame = Record<string, unknown>;

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: Frame[] = [];
  closeCalls: { code: number; reason: string }[] = [];

  send(frame: string) {
    this.sent.push(JSON.parse(frame) as Frame);
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== this.OPEN) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  ops(op: string): Frame[] {
    return this.sent.filter((frame) => frame.op === op);
  }
}

interface ContainerSpec {
  name: string;
  state: 'running' | 'waiting' | 'terminated';
  reason?: string;
  id?: string;
  restarts?: number;
}

function pod(
  name: string,
  containers: ContainerSpec[],
  options: { uid?: string; rs?: string; deleting?: boolean; phase?: string; labels?: Record<string, string> } = {},
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'ops',
      uid: options.uid ?? `uid-${name}`,
      labels: options.labels ?? { app: 'web' },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: options.rs ?? 'web-1', uid: `uid-${options.rs ?? 'web-1'}`, controller: true }],
      ...(options.deleting ? { deletionTimestamp: '2026-07-22T12:00:00Z' } : {}),
    },
    spec: { containers: containers.map((container) => ({ name: container.name })) },
    status: {
      phase: options.phase ?? 'Running',
      containerStatuses: containers.map((container) => ({
        name: container.name,
        restartCount: container.restarts ?? 0,
        containerID: container.state === 'waiting' ? undefined : (container.id ?? `cri://${name}-${container.name}`),
        state:
          container.state === 'running'
            ? { running: {} }
            : container.state === 'terminated'
              ? { terminated: { exitCode: 0, containerID: container.id ?? `cri://${name}-${container.name}` } }
              : { waiting: { reason: container.reason ?? 'ContainerCreating' } },
      })),
    },
  };
}

const deployment: KubeObject = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'ops', uid: 'deploy-uid' },
  spec: { selector: { matchLabels: { app: 'web' } } },
};

function replicaSet(name: string): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: { name, namespace: 'ops', uid: `uid-${name}`, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'deploy-uid', controller: true }] },
  };
}

/** A cluster at the ClusterHandle seam: a pods watcher we drive, and log streams we push lines into. */
function fakeCluster(initialPods: KubeObject[], objects: Record<string, KubeObject> = {}) {
  let items = [...initialPods];
  const subscribers = new Set<WatcherSubscriber>();
  const streams = new Map<string, Readable>();
  const streamCalls: string[] = [];
  const release = vi.fn();
  const watcher = {
    ready: async () => {},
    currentState: () => 'live',
    items: () => items,
    subscribe(sub: WatcherSubscriber) {
      subscribers.add(sub);
      return () => subscribers.delete(sub);
    },
  };
  const handle = {
    watchers: { acquire: () => ({ watcher, release }) },
    core: {
      async readNamespacedPod({ name }: { name: string }) {
        const found = items.find((item) => item.metadata.name === name);
        if (!found) throw Object.assign(new Error('not found'), { code: 404 });
        return found;
      },
    },
    raw: {
      async json(path: string) {
        const found = Object.entries(objects).find(([suffix]) => path.startsWith(suffix));
        if (!found) throw Object.assign(new Error(`unexpected ${path}`), { code: 404 });
        return found[1];
      },
      async stream(path: string, options: { signal: AbortSignal }) {
        streamCalls.push(path);
        const match = /pods\/([^/]+)\/log\?container=([^&]*)/.exec(path)!;
        const key = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
        if (key.startsWith('gone-')) throw Object.assign(new Error('pods "gone" not found'), { code: 404 });
        const body = new Readable({ read() {} });
        options.signal.addEventListener('abort', () => body.destroy(new DOMException('aborted', 'AbortError')), { once: true });
        streams.set(key, body);
        return { ok: true, status: 200, statusText: 'OK', body, text: async () => '' };
      },
    },
  };
  const emit = (type: 'ADDED' | 'MODIFIED' | 'DELETED', object: KubeObject) => {
    items = type === 'DELETED' ? items.filter((item) => item.metadata.uid !== object.metadata.uid) : [...items.filter((item) => item.metadata.uid !== object.metadata.uid), object];
    for (const sub of subscribers) sub.onDeltas([{ type, object }]);
  };
  return { handle, emit, streams, streamCalls, release, subscribers };
}

function openSocket(handle: unknown, query: Record<string, string>): FakeSocket {
  let route: Handler | undefined;
  const app = {
    get(_path: string, _options: unknown, handler: Handler) {
      route = handler;
    },
  } as unknown as FastifyInstance;
  registerLogsSocket(app, { clusters: { get: () => handle } } as unknown as AppContext);
  const socket = new FakeSocket();
  route!(socket, { query: { ctx: 'dev', namespace: 'ops', follow: 'true', tailLines: '100', ...query } });
  return socket;
}

/** Let pending stream and queue callbacks run. */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for the log session');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('containerRun', () => {
  it('names the run the kubelet would serve logs for', () => {
    expect(containerRun(pod('a', [{ name: 'app', state: 'running', id: 'cri://1' }]), 'app')).toEqual({ id: 'cri://1', running: true });
    expect(containerRun(pod('a', [{ name: 'app', state: 'terminated', id: 'cri://2' }]), 'app')).toEqual({ id: 'cri://2', running: false });
    expect(containerRun(pod('a', [{ name: 'app', state: 'waiting', reason: 'ContainerCreating' }]), 'app')).toEqual({ running: false, waiting: 'ContainerCreating' });
    const crashing = pod('a', [{ name: 'app', state: 'waiting', reason: 'CrashLoopBackOff', restarts: 3 }]);
    (crashing.status as { containerStatuses: Array<Record<string, unknown>> }).containerStatuses[0]!.lastState = { terminated: { containerID: 'cri://old' } };
    expect(containerRun(crashing, 'app')).toEqual({ id: 'cri://old', running: false, waiting: 'CrashLoopBackOff' });
    const unscheduled: KubeObject = { metadata: { name: 'a', uid: 'u' }, status: { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] } };
    expect(containerRun(unscheduled, 'app')).toEqual({ running: false, waiting: 'Unschedulable' });
    expect(containerRun(undefined, 'app')).toEqual({ running: false, waiting: 'Pending' });
  });
});

describe('workload log sessions', () => {
  it('follow a Deployment through a rollout without closing the socket', async () => {
    const oldPod = pod('web-1-a', [{ name: 'app', state: 'running' }]);
    const cluster = fakeCluster([oldPod, pod('lookalike', [{ name: 'app', state: 'running' }], { rs: 'other' })], {
      '/apis/apps/v1/namespaces/ops/deployments/web': deployment,
      '/apis/apps/v1/namespaces/ops/replicasets/web-1': replicaSet('web-1'),
      '/apis/apps/v1/namespaces/ops/replicasets/web-2': replicaSet('web-2'),
    });
    const socket = openSocket(cluster.handle, { target: 'Deployment', targetName: 'web' });
    await settle(() => cluster.streams.has('web-1-a/app'));
    expect(socket.ops('pods')).toEqual([{ op: 'pods', pods: [{ pod: 'web-1-a', containers: ['app'] }] }]);
    cluster.streams.get('web-1-a/app')!.push('2026-07-22T12:00:00.000000000Z old line\n');

    // The rollout creates a pod whose container has not started yet.
    const created = pod('web-2-a', [{ name: 'app', state: 'waiting' }], { rs: 'web-2' });
    cluster.emit('ADDED', created);
    await settle(() => socket.ops('pod-joined').length === 1 && socket.ops('pod-status').some((frame) => frame.state === 'waiting'));
    expect(socket.ops('pod-joined')).toEqual([{ op: 'pod-joined', pod: 'web-2-a', containers: ['app'] }]);
    expect(socket.sent).toContainEqual({ op: 'pod-status', pod: 'web-2-a', container: 'app', state: 'waiting', message: 'ContainerCreating' });
    expect(cluster.streams.has('web-2-a/app')).toBe(false);

    // Its container starts: it becomes a source.
    cluster.emit('MODIFIED', pod('web-2-a', [{ name: 'app', state: 'running' }], { rs: 'web-2' }));
    await settle(() => cluster.streams.has('web-2-a/app'));
    cluster.streams.get('web-2-a/app')!.push('2026-07-22T12:00:05.000000000Z new line\n');

    // The old pod terminates: its stream ends and the pod retires.
    cluster.emit('MODIFIED', pod('web-1-a', [{ name: 'app', state: 'running' }], { deleting: true }));
    cluster.streams.get('web-1-a/app')!.push('2026-07-22T12:00:06.000000000Z shutting down\n');
    cluster.streams.get('web-1-a/app')!.push(null);
    await settle(() => socket.ops('pod-left').length === 1);
    expect(socket.ops('pod-left')).toEqual([{ op: 'pod-left', pod: 'web-1-a', reason: 'terminated' }]);
    cluster.emit('DELETED', oldPod);
    await drain();

    expect(socket.ops('line').map((frame) => `${String(frame.pod)}: ${String(frame.line)}`)).toEqual(['web-1-a: old line', 'web-2-a: new line', 'web-1-a: shutting down']);
    expect(socket.ops('pod-left')).toHaveLength(1);
    expect(socket.ops('pod-status').filter((frame) => frame.state === 'error')).toEqual([]);
    expect(socket.closeCalls).toEqual([]);
    expect(cluster.streamCalls.some((path) => path.includes('lookalike'))).toBe(false);

    socket.close(1000, 'done');
    expect(cluster.release).toHaveBeenCalled();
    expect(cluster.subscribers.size).toBe(0);
  });

  it('leave out excluded pods and restart a crashed container from where it stopped', async () => {
    const cluster = fakeCluster(
      [pod('web-1-a', [{ name: 'app', state: 'running', id: 'cri://run-1' }]), pod('web-1-b', [{ name: 'app', state: 'running' }])],
      {
        '/apis/apps/v1/namespaces/ops/deployments/web': deployment,
        '/apis/apps/v1/namespaces/ops/replicasets/web-1': replicaSet('web-1'),
      },
    );
    const socket = openSocket(cluster.handle, { target: 'Deployment', targetName: 'web', exclude: 'web-1-b', containers: 'app' });
    await settle(() => cluster.streams.has('web-1-a/app'));
    expect(cluster.streams.has('web-1-b/app')).toBe(false);
    expect(socket.ops('pods')[0]).toEqual({ op: 'pods', pods: [{ pod: 'web-1-a', containers: ['app'] }, { pod: 'web-1-b', containers: ['app'] }] });

    cluster.streams.get('web-1-a/app')!.push('2026-07-22T12:00:01.000000000Z before crash\n');
    const crashed = pod('web-1-a', [{ name: 'app', state: 'waiting', reason: 'CrashLoopBackOff', restarts: 1 }]);
    (crashed.status as { containerStatuses: Array<Record<string, unknown>> }).containerStatuses[0]!.lastState = { terminated: { containerID: 'cri://run-1' } };
    cluster.emit('MODIFIED', crashed);
    cluster.streams.get('web-1-a/app')!.push(null);
    await settle(() => socket.sent.some((frame) => frame.state === 'waiting' && frame.message === 'CrashLoopBackOff'));

    cluster.emit('MODIFIED', pod('web-1-a', [{ name: 'app', state: 'running', id: 'cri://run-2', restarts: 1 }]));
    await settle(() => cluster.streamCalls.length === 2);
    expect(cluster.streamCalls[1]).toContain('sinceTime=2026-07-22T12%3A00%3A01.000000000Z');
    expect(cluster.streamCalls[1]).not.toContain('tailLines');
    expect(socket.closeCalls).toEqual([]);
  });

  it('ask the client to reconnect when a live stream breaks while its container keeps running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cluster = fakeCluster([pod('web-1-a', [{ name: 'app', state: 'running' }])], {
      '/apis/apps/v1/namespaces/ops/deployments/web': deployment,
      '/apis/apps/v1/namespaces/ops/replicasets/web-1': replicaSet('web-1'),
    });
    const socket = openSocket(cluster.handle, { target: 'Deployment', targetName: 'web' });
    await settle(() => cluster.streams.has('web-1-a/app'));
    cluster.streams.get('web-1-a/app')!.destroy(new Error('kubelet went away'));
    await drain();
    // The watcher still says running: give it a moment to report an exit first.
    expect(socket.closeCalls).toEqual([]);
    vi.advanceTimersByTime(3_000);
    await settle(() => socket.closeCalls.length === 1);
    expect(socket.closeCalls).toEqual([{ code: 1011, reason: 'upstream log stream failed' }]);
    expect(socket.sent).toContainEqual({ op: 'pod-status', pod: 'web-1-a', container: 'app', state: 'error', message: 'kubelet went away' });
  });

  it('call a gracefully deleted pod terminated even when its deletion arrives before its last lines', async () => {
    const cluster = fakeCluster([pod('web-1-a', [{ name: 'app', state: 'running' }])], {
      '/apis/apps/v1/namespaces/ops/deployments/web': deployment,
      '/apis/apps/v1/namespaces/ops/replicasets/web-1': replicaSet('web-1'),
    });
    const socket = openSocket(cluster.handle, { target: 'Deployment', targetName: 'web' });
    await settle(() => cluster.streams.has('web-1-a/app'));
    cluster.emit('DELETED', pod('web-1-a', [{ name: 'app', state: 'terminated' }], { deleting: true }));
    await settle(() => socket.ops('pod-left').length === 1);
    expect(socket.ops('pod-left')).toEqual([{ op: 'pod-left', pod: 'web-1-a', reason: 'terminated' }]);
    expect(socket.closeCalls).toEqual([]);
  });

  it('stay open while a workload has no pods and pick up the first one', async () => {
    const cluster = fakeCluster([], {
      '/apis/apps/v1/namespaces/ops/statefulsets/db': {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: { name: 'db', namespace: 'ops', uid: 'sts-uid' },
        spec: { selector: { matchLabels: { app: 'db' } } },
      },
    });
    const socket = openSocket(cluster.handle, { target: 'StatefulSet', targetName: 'db' });
    await settle(() => socket.ops('pods').length === 1);
    expect(socket.ops('pods')[0]).toEqual({ op: 'pods', pods: [] });
    const dbPod = pod('db-0', [{ name: 'db', state: 'running' }], { labels: { app: 'db' } });
    dbPod.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'db', uid: 'sts-uid', controller: true }];
    cluster.emit('ADDED', dbPod);
    await settle(() => cluster.streams.has('db-0/db'));
    expect(socket.closeCalls).toEqual([]);
  });

  it('report a missing workload without retrying', async () => {
    const cluster = fakeCluster([]);
    const socket = openSocket(cluster.handle, { target: 'Deployment', targetName: 'nope' });
    await settle(() => socket.closeCalls.length === 1);
    expect(socket.closeCalls).toEqual([{ code: LOG_SOCKET_NO_STREAMS_CODE, reason: 'log target not found' }]);
    expect(socket.ops('pod-status')[0]).toMatchObject({ state: 'error', message: 'Deployment ops/nope not found' });
  });
});

describe('fixed pod log sessions', () => {
  it('wait for a container to start instead of failing', async () => {
    const cluster = fakeCluster([pod('api-0', [{ name: 'app', state: 'waiting' }])]);
    const socket = openSocket(cluster.handle, { pods: 'api-0' });
    await settle(() => socket.ops('pod-status').length === 1);
    expect(socket.ops('pod-status')[0]).toEqual({ op: 'pod-status', pod: 'api-0', container: 'app', state: 'waiting', message: 'ContainerCreating' });
    expect(socket.ops('pods')).toEqual([]);
    cluster.emit('MODIFIED', pod('api-0', [{ name: 'app', state: 'running' }]));
    await settle(() => cluster.streams.has('api-0/app'));
    expect(socket.closeCalls).toEqual([]);
  });

  it('retire deleted pods and complete once none is left', async () => {
    const cluster = fakeCluster([pod('api-0', [{ name: 'app', state: 'running' }])]);
    const socket = openSocket(cluster.handle, { pods: 'api-0,gone-1' });
    await settle(() => cluster.streams.has('api-0/app') && socket.ops('pod-left').length === 1);
    expect(socket.ops('pod-left')).toEqual([{ op: 'pod-left', pod: 'gone-1', reason: 'deleted' }]);
    cluster.emit('DELETED', pod('api-0', [{ name: 'app', state: 'running' }]));
    await settle(() => socket.closeCalls.length === 1);
    expect(socket.ops('pod-left')).toHaveLength(2);
    expect(socket.closeCalls).toEqual([{ code: LOG_SOCKET_COMPLETE_CODE, reason: 'log session complete' }]);
  });

  it('complete when a finished pod has been read to the end', async () => {
    const cluster = fakeCluster([pod('job-a', [{ name: 'worker', state: 'terminated' }], { phase: 'Succeeded' })]);
    const socket = openSocket(cluster.handle, { pods: 'job-a' });
    await settle(() => cluster.streams.has('job-a/worker'));
    cluster.streams.get('job-a/worker')!.push('2026-07-22T12:00:00.000000000Z done\n');
    cluster.streams.get('job-a/worker')!.push(null);
    await settle(() => socket.closeCalls.length === 1);
    expect(socket.closeCalls).toEqual([{ code: LOG_SOCKET_COMPLETE_CODE, reason: 'log session complete' }]);
  });

  it('reject a request without pods or target', async () => {
    const socket = openSocket(fakeCluster([]).handle, {});
    expect(socket.closeCalls).toEqual([{ code: LOG_SOCKET_NO_STREAMS_CODE, reason: 'invalid log request' }]);
    expect(socket.ops('pod-status')[0]?.message).toMatch(/^Invalid log request/);
  });
});
