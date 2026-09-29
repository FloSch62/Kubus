import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EXEC_SESSION_CLOSE_REASON } from '@kubus/shared';
import type { AppContext } from '../../../server/src/app.js';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { createNodeDebugPod, NODE_DEBUG_COMMAND } from '../../../server/src/kube/node-shell.js';
import { registerNodeShellSocket } from '../../../server/src/ws/node-shell-socket.js';
import { ExecSessionRegistry } from '../../../server/src/ws/transferable-exec.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface PodBody {
  metadata: { name: string; namespace: string; annotations: Record<string, string> };
  spec: {
    nodeName: string;
    hostPID: boolean;
    hostNetwork: boolean;
    hostIPC: boolean;
    volumes: Array<{ name: string; hostPath: { path: string } }>;
    containers: Array<{ name: string; image: string; securityContext?: object; volumeMounts: Array<{ name: string; mountPath: string }> }>;
  };
}

/** Fake API server: the debug namespace exists, created pods report `containerState` for their first container. */
function fakeCluster(containerState: object = { running: {} }) {
  const calls: Call[] = [];
  const raw = {
    async json(path: string, init?: { method?: string; body?: string }) {
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === 'GET' && path.includes('/pods/')) {
        return { status: { phase: 'Pending', containerStatuses: [{ name: 'debugger', state: containerState }] } };
      }
      if (method === 'GET' && path.includes('/pods')) return { items: [] };
      return {};
    },
  };
  return { calls, handle: { raw } as unknown as ClusterHandle };
}

const created = (calls: Call[]) => calls.find((c) => c.method === 'POST' && c.path.endsWith('/pods'))?.body as PodBody | undefined;
const deleted = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

describe('createNodeDebugPod', () => {
  it('creates a kubectl-debug-node style pod with the node root at /host', async () => {
    const { calls, handle } = fakeCluster();
    const result = await createNodeDebugPod(handle, 'worker-1', { image: ' nicolaka/netshoot:v0.16 ' });

    const pod = created(calls);
    expect(result).toEqual({ namespace: 'kubus-debug', pod: pod?.metadata.name, container: 'debugger' });
    expect(pod?.metadata.name).toMatch(/^kubus-node-debug-[a-z0-9]{6}$/);
    expect(pod?.metadata.annotations).toMatchObject({ 'kubus.io/node': 'worker-1', 'kubus.io/image': 'nicolaka/netshoot:v0.16', 'kubus.io/debug-profile': 'general' });
    expect(pod?.spec).toMatchObject({ nodeName: 'worker-1', hostPID: true, hostNetwork: true, hostIPC: true });
    expect(pod?.spec.volumes).toEqual([{ name: 'host-root', hostPath: { path: '/' } }]);
    const container = pod?.spec.containers[0];
    expect(container).toMatchObject({ name: 'debugger', image: 'nicolaka/netshoot:v0.16', volumeMounts: [{ name: 'host-root', mountPath: '/host' }] });
    expect(container?.securityContext).toBeUndefined();
    expect(deleted(calls)).toEqual([]);
  });

  it.each([
    ['netadmin', { capabilities: { add: ['NET_ADMIN', 'NET_RAW'] } }],
    ['sysadmin', { privileged: true }],
  ] as const)('applies the %s profile to the container', async (profile, securityContext) => {
    const { calls, handle } = fakeCluster();
    await createNodeDebugPod(handle, 'worker-1', { image: 'busybox:1.36', profile });
    expect(created(calls)?.spec.containers[0]?.securityContext).toEqual(securityContext);
  });

  it.each([
    [{ image: '' }, /image is required/],
    [{ image: 'busybox latest' }, /without whitespace/],
    [{ image: 'busybox:1.36', profile: 'restricted' as const }, /restricted profile cannot debug a node/],
    [{ image: 'busybox:1.36', profile: 'toString' as never }, /unknown debug profile/],
  ])('rejects %j before creating anything', async (opts, message) => {
    const { calls, handle } = fakeCluster();
    await expect(createNodeDebugPod(handle, 'worker-1', opts)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('deletes the pod when the image cannot be pulled', async () => {
    const { calls, handle } = fakeCluster({ waiting: { reason: 'ImagePullBackOff', message: 'not found' } });
    await expect(createNodeDebugPod(handle, 'worker-1', { image: 'nope:missing' })).rejects.toThrow(/ImagePullBackOff/);
    const name = created(calls)?.metadata.name;
    expect(deleted(calls)).toEqual([expect.stringContaining(`/namespaces/kubus-debug/pods/${name}`)]);
  });

  it('reports waiting reasons once each and deletes the pod when abandoned', async () => {
    const { calls, handle } = fakeCluster({ waiting: { reason: 'ContainerCreating' } });
    const abandon = new AbortController();
    const reasons: string[] = [];
    const pending = createNodeDebugPod(handle, 'worker-1', {
      image: 'busybox:1.36',
      signal: abandon.signal,
      onWaiting: (reason) => {
        reasons.push(reason);
        setTimeout(() => abandon.abort(), 20);
      },
    });
    await expect(pending).rejects.toThrow();
    expect(reasons).toEqual(['ContainerCreating']);
    expect(deleted(calls)).toHaveLength(1);
  });
});

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: unknown[] = [];

  send(data: unknown) {
    this.sent.push(data);
  }

  ping() {}

  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for node debug setup');
}

it('the node-shell socket runs a login shell inside the debug image and deletes the pod on close', async () => {
  const routes = new Map<string, (socket: unknown, request: unknown) => unknown>();
  const app = {
    get(path: string, _options: unknown, handler: (socket: unknown, request: unknown) => unknown) {
      routes.set(path, handler);
    },
    log: { warn() {} },
  } as unknown as FastifyInstance;
  const { calls, handle } = fakeCluster();
  const commands: string[][] = [];
  const upstream = new FakeSocket();
  Object.assign(handle, {
    makeExec: () => ({
      async exec(_namespace: string, _pod: string, _container: string, command: string[]) {
        commands.push(command);
        return upstream;
      },
    }),
  });
  const ctx = { clusters: { get: () => handle }, execSessions: new ExecSessionRegistry() } as unknown as AppContext;
  registerNodeShellSocket(app, ctx);

  const socket = new FakeSocket();
  routes.get('/ws/node-shell')?.(socket, { query: { ctx: 'dev', node: 'worker-1', image: 'busybox:1.36', profile: 'netadmin' } });
  await waitFor(() => commands.length > 0);

  expect(commands).toEqual([NODE_DEBUG_COMMAND]);
  expect(created(calls)?.spec.containers[0]).toMatchObject({ image: 'busybox:1.36', securityContext: { capabilities: { add: ['NET_ADMIN', 'NET_RAW'] } } });
  const output = socket.sent.filter((chunk) => Buffer.isBuffer(chunk)).map(String).join('');
  expect(output).toContain('Starting debug pod on worker-1 with busybox:1.36');
  expect(output).toContain('/host');

  upstream.emit('close');
  await waitFor(() => deleted(calls).length > 0);
  expect(deleted(calls)).toEqual([expect.stringContaining(`/pods/${created(calls)?.metadata.name}`)]);
});

it('deletes the debug pod when the terminal closes while the exec handshake is pending', async () => {
  const routes = new Map<string, (socket: unknown, request: unknown) => unknown>();
  const app = {
    get(path: string, _options: unknown, handler: (socket: unknown, request: unknown) => unknown) {
      routes.set(path, handler);
    },
    log: { warn() {} },
  } as unknown as FastifyInstance;
  const { calls, handle } = fakeCluster();
  const upstream = new FakeSocket();
  let finishHandshake: (() => void) | undefined;
  Object.assign(handle, {
    makeExec: () => ({
      exec: () =>
        new Promise((resolve) => {
          finishHandshake = () => resolve(upstream);
        }),
    }),
  });
  const ctx = { clusters: { get: () => handle }, execSessions: new ExecSessionRegistry() } as unknown as AppContext;
  registerNodeShellSocket(app, ctx);

  const socket = new FakeSocket();
  routes.get('/ws/node-shell')?.(socket, { query: { ctx: 'dev', node: 'worker-1', image: 'busybox:1.36' } });
  await waitFor(() => finishHandshake !== undefined);

  socket.readyState = 3;
  socket.emit('close', 1000, Buffer.from(EXEC_SESSION_CLOSE_REASON));
  await waitFor(() => deleted(calls).length > 0);
  expect(deleted(calls)).toEqual([expect.stringContaining(`/pods/${created(calls)?.metadata.name}`)]);

  finishHandshake?.();
  await waitFor(() => upstream.readyState !== upstream.OPEN);
  expect(deleted(calls)).toHaveLength(1);
});
