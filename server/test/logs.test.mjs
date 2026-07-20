import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LOG_SOCKET_COMPLETE_CODE } from '@kubus/shared';
import { registerDetailRoutes } from '../dist/routes/detail.js';
import { registerLogsSocket } from '../dist/ws/logs-socket.js';

function routeCollector() {
  const routes = new Map();
  return {
    routes,
    app: {
      get(path, optionsOrHandler, handler) {
        routes.set(path, handler ?? optionsOrHandler);
      },
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for asynchronous log setup');
}

void test('Job log targets contain only Pods directly owned by the Job', async () => {
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
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'report', uid: 'job-uid', controller: true }],
    },
    spec: { containers: [{ name: 'worker' }], initContainers: [{ name: 'setup' }] },
  };
  const unrelatedPod = {
    ...ownedPod,
    metadata: {
      ...ownedPod.metadata,
      name: 'other-abc',
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'other', uid: 'other-uid', controller: true }],
    },
  };
  const jsonCalls = [];
  const handle = {
    raw: {
      async json(path) {
        jsonCalls.push(path);
        return jsonCalls.length === 1 ? target : { items: [unrelatedPod, ownedPod] };
      },
    },
  };
  registerDetailRoutes(app, { clusters: { get: () => handle } });

  const handler = routes.get('/api/contexts/:ctx/detail/log-target-pods');
  const response = await handler(
    {
      params: { ctx: 'dev' },
      query: { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job', namespace: 'ops', name: 'report' },
    },
    {},
  );

  assert.deepEqual(response, {
    pods: [{ name: 'report-abc', namespace: 'ops', containers: ['worker', 'setup'] }],
  });
  assert.match(jsonCalls[1], /labelSelector=batch\.kubernetes\.io%2Fcontroller-uid%3Djob-uid/);
});

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent = [];
  closeCalls = [];

  send(frame) {
    this.sent.push(JSON.parse(frame));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== this.OPEN) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

void test('log sockets stream selected containers and resume each source from its timestamp', async () => {
  const { app, routes } = routeCollector();
  const calls = [];
  const controllers = [];
  const handle = {
    core: {
      async readNamespacedPod() {
        return { spec: { containers: [{ name: 'app' }, { name: 'sidecar' }] } };
      },
    },
    makeLog() {
      return {
        async log(namespace, pod, container, sink, options) {
          calls.push({ namespace, pod, container, options });
          // No trailing newline exercises the stream finalizer's timestamp parser.
          sink.end(Buffer.from('2026-01-02T03:04:06.000000000Z resumed line'));
          const controller = new AbortController();
          controllers.push(controller);
          return controller;
        },
      };
    },
  };
  registerLogsSocket(app, { clusters: { get: () => handle } });

  const socket = new FakeSocket();
  const handler = routes.get('/ws/logs');
  handler(socket, {
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
  await waitFor(() => calls.length === 1 && socket.sent.some((message) => message.op === 'line') && socket.closeCalls.length === 1);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    namespace: 'ops',
    pod: 'api-0',
    container: 'app',
    options: {
      follow: true,
      tailLines: undefined,
      sinceSeconds: undefined,
      sinceTime: '2026-01-02T03:04:05.000000000Z',
      previous: false,
      timestamps: true,
    },
  });
  assert.deepEqual(socket.sent.find((message) => message.op === 'line'), {
    op: 'line',
    pod: 'api-0',
    container: 'app',
    ts: '2026-01-02T03:04:06.000000000Z',
    line: 'resumed line',
  });

  assert.deepEqual(socket.closeCalls, [{ code: 1011, reason: 'upstream log stream ended' }]);
  assert.equal(controllers[0].signal.aborted, true);
});

void test('completed containers close a follow session without requesting a retry', async () => {
  const { app, routes } = routeCollector();
  const controllers = [];
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
    makeLog() {
      return {
        async log(_namespace, _pod, _container, sink) {
          sink.end(Buffer.from('2026-01-02T03:04:06.000000000Z complete'));
          const controller = new AbortController();
          controllers.push(controller);
          return controller;
        },
      };
    },
  };
  registerLogsSocket(app, { clusters: { get: () => handle } });

  const socket = new FakeSocket();
  routes.get('/ws/logs')(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pods: 'job-abc',
      containers: 'worker',
      follow: 'true',
    },
  });
  await waitFor(() => socket.closeCalls.length === 1);

  assert.deepEqual(socket.closeCalls, [{ code: LOG_SOCKET_COMPLETE_CODE, reason: 'log session complete' }]);
  assert.equal(controllers[0].signal.aborted, true);
});

void test('an interrupted live upstream stream closes the socket for retry', async () => {
  const { app, routes } = routeCollector();
  const handle = {
    core: {
      async readNamespacedPod() {
        return {
          spec: { containers: [{ name: 'app' }] },
          status: {
            containerStatuses: [{ name: 'app', state: { running: { startedAt: '2026-01-02T03:04:05Z' } } }],
          },
        };
      },
    },
    makeLog() {
      return {
        async log(_namespace, _pod, _container, sink) {
          queueMicrotask(() => sink.emit('unpipe'));
          return new AbortController();
        },
      };
    },
  };
  registerLogsSocket(app, { clusters: { get: () => handle } });

  const socket = new FakeSocket();
  routes.get('/ws/logs')(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pods: 'api-0',
      containers: 'app',
      follow: 'true',
    },
  });
  await waitFor(() => socket.closeCalls.length === 1);

  assert.deepEqual(socket.closeCalls, [{ code: 1011, reason: 'upstream log stream failed' }]);
  assert.equal(socket.sent.some((message) => message.op === 'pod-status' && message.state === 'error'), true);
});
