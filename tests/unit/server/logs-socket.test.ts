import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { LOG_SOCKET_COMPLETE_CODE } from '@kubus/shared';
import { expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../server/src/app.js';
import { registerDetailRoutes } from '../../../server/src/routes/detail.js';
import { registerLogsSocket } from '../../../server/src/ws/logs-socket.js';

type Handler = (a: unknown, b: unknown) => unknown;

function routeCollector() {
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, optionsOrHandler: unknown, handler?: unknown) {
      routes.set(path, (handler ?? optionsOrHandler) as Handler);
    },
  } as unknown as FastifyInstance;
  return { routes, app };
}

function appContext(handle: unknown): AppContext {
  return { clusters: { get: () => handle } } as unknown as AppContext;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for asynchronous log setup');
}

it('Job log targets contain only Pods directly owned by the Job', async () => {
  const { app, routes } = routeCollector();
  const target = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'report', namespace: 'ops', uid: 'job-uid' },
    spec: { selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': 'job-uid' } } },
  };
  const ownedPod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'report-abc',
      namespace: 'ops',
      ownerReferences: [
        { apiVersion: 'batch/v1', kind: 'Job', name: 'report', uid: 'job-uid', controller: true },
      ],
    },
    spec: { containers: [{ name: 'worker' }], initContainers: [{ name: 'setup' }] },
  };
  const unrelatedPod = {
    ...ownedPod,
    metadata: {
      ...ownedPod.metadata,
      name: 'other-abc',
      ownerReferences: [
        { apiVersion: 'batch/v1', kind: 'Job', name: 'other', uid: 'other-uid', controller: true },
      ],
    },
  };
  const jsonCalls: string[] = [];
  const handle = {
    raw: {
      async json(path: string) {
        jsonCalls.push(path);
        return jsonCalls.length === 1 ? target : { items: [unrelatedPod, ownedPod] };
      },
    },
  };
  registerDetailRoutes(app, appContext(handle));

  const handler = routes.get('/api/contexts/:ctx/detail/log-target-pods');
  const response = await handler?.(
    {
      params: { ctx: 'dev' },
      query: {
        group: 'batch',
        version: 'v1',
        plural: 'jobs',
        kind: 'Job',
        namespace: 'ops',
        name: 'report',
      },
    },
    {},
  );

  expect(response).toEqual({
    pods: [{ name: 'report-abc', namespace: 'ops', containers: ['worker', 'setup'] }],
  });
  expect(jsonCalls[1]).toMatch(/labelSelector=batch\.kubernetes\.io%2Fcontroller-uid%3Djob-uid/);
});

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: Record<string, unknown>[] = [];
  closeCalls: { code: number; reason: string }[] = [];

  send(frame: string) {
    this.sent.push(JSON.parse(frame));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== this.OPEN) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

function streamResponse(body: Readable) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body,
    async text() {
      return '';
    },
  };
}

it('log sockets stream selected containers and resume each source from its timestamp', async () => {
  const { app, routes } = routeCollector();
  const calls: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const handle = {
    core: {
      async readNamespacedPod() {
        return { spec: { containers: [{ name: 'app' }, { name: 'sidecar' }] } };
      },
    },
    raw: {
      async stream(path: string, options: { signal: AbortSignal; deadlineMs: false }) {
        calls.push({ path, options });
        signals.push(options.signal);
        // No trailing newline exercises the stream finalizer's timestamp parser.
        return streamResponse(Readable.from([Buffer.from('2026-01-02T03:04:06.000000000Z resumed line')]));
      },
    },
  };
  registerLogsSocket(app, appContext(handle));

  const socket = new FakeSocket();
  const handler = routes.get('/ws/logs');
  handler?.(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pods: 'api-0',
      containers: 'app',
      follow: 'true',
      tailLines: '500',
      sinceSeconds: '600',
      resumeAt: JSON.stringify({ 'api-0/app': '2026-01-02T03:04:05.000000000Z' }),
    },
  });
  await waitFor(
    () =>
      calls.length === 1 &&
      socket.sent.some((message) => message.op === 'line') &&
      socket.closeCalls.length === 1,
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    path:
      '/api/v1/namespaces/ops/pods/api-0/log?container=app&follow=true&previous=false&timestamps=true&sinceTime=2026-01-02T03%3A04%3A05.000000000Z',
    options: {
      signal: signals[0],
      deadlineMs: false,
    },
  });
  expect(socket.sent.find((message) => message.op === 'line')).toEqual({
    op: 'line',
    pod: 'api-0',
    container: 'app',
    ts: '2026-01-02T03:04:06.000000000Z',
    line: 'resumed line',
  });

  expect(socket.closeCalls).toEqual([{ code: 1011, reason: 'upstream log stream ended' }]);
  expect(signals[0]?.aborted).toBe(true);
});

it('completed containers close a follow session without requesting a retry', async () => {
  const { app, routes } = routeCollector();
  const signals: AbortSignal[] = [];
  const handle = {
    core: {
      async readNamespacedPod() {
        return {
          spec: { containers: [{ name: 'worker' }] },
          status: {
            containerStatuses: [{ name: 'worker', state: { terminated: { exitCode: 0 } } }],
          },
        };
      },
    },
    raw: {
      async stream(_path: string, options: { signal: AbortSignal }) {
        signals.push(options.signal);
        return streamResponse(Readable.from([Buffer.from('2026-01-02T03:04:06.000000000Z complete')]));
      },
    },
  };
  registerLogsSocket(app, appContext(handle));

  const socket = new FakeSocket();
  routes.get('/ws/logs')?.(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pods: 'job-abc',
      containers: 'worker',
      follow: 'true',
    },
  });
  await waitFor(() => socket.closeCalls.length === 1);

  expect(socket.closeCalls).toEqual([
    { code: LOG_SOCKET_COMPLETE_CODE, reason: 'log session complete' },
  ]);
  expect(signals[0]?.aborted).toBe(true);
});

it('an interrupted live upstream stream closes the socket for retry', async () => {
  const { app, routes } = routeCollector();
  const upstream = new Readable({ read() {} });
  const handle = {
    core: {
      async readNamespacedPod() {
        return {
          spec: { containers: [{ name: 'app' }] },
          status: {
            containerStatuses: [
              { name: 'app', state: { running: { startedAt: '2026-01-02T03:04:05Z' } } },
            ],
          },
        };
      },
    },
    raw: {
      async stream() {
        return streamResponse(upstream);
      },
    },
  };
  registerLogsSocket(app, appContext(handle));

  const socket = new FakeSocket();
  routes.get('/ws/logs')?.(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pods: 'api-0',
      containers: 'app',
      follow: 'true',
    },
  });
  await waitFor(() => socket.sent.some((message) => message.op === 'pod-status' && message.state === 'streaming'));
  upstream.destroy(new Error('upstream reset'));
  await waitFor(() => socket.closeCalls.length === 1);

  expect(socket.closeCalls).toEqual([{ code: 1011, reason: 'upstream log stream failed' }]);
  expect(socket.sent.some((message) => message.op === 'pod-status' && message.state === 'error')).toBe(
    true,
  );
});

it('handles the upstream AbortError when a log socket disconnects', async () => {
  const { app, routes } = routeCollector();
  const upstream = new Readable({ read() {} });
  let signal: AbortSignal | undefined;
  const handle = {
    core: {
      async readNamespacedPod() {
        return { spec: { containers: [{ name: 'app' }] } };
      },
    },
    raw: {
      async stream(_path: string, options: { signal: AbortSignal }) {
        signal = options.signal;
        signal.addEventListener(
          'abort',
          () => upstream.destroy(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
        return streamResponse(upstream);
      },
    },
  };
  registerLogsSocket(app, appContext(handle));

  const socket = new FakeSocket();
  routes.get('/ws/logs')?.(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pods: 'api-0',
      containers: 'app',
      follow: 'true',
    },
  });
  await waitFor(() => socket.sent.some((message) => message.op === 'pod-status' && message.state === 'streaming'));

  socket.close(1000, 'client disconnected');
  await waitFor(() => signal?.aborted === true && upstream.destroyed);

  expect(socket.sent.some((message) => message.op === 'pod-status' && message.state === 'error')).toBe(false);
});
