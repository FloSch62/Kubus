import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { registerActionRoutes } from '../../../server/src/routes/actions';
import { HttpProblem } from '../../../server/src/util/errors';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness() {
  let debugName = 'debug-test';
  const raw = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (path.endsWith('/ephemeralcontainers') && init?.body) {
      debugName = JSON.parse(init.body).spec.ephemeralContainers[0].name;
      return {};
    }
    if (path.endsWith('/pods/web-0')) {
      return {
        spec: { ephemeralContainers: [{ name: debugName, command: ['/tmp/.kubus-stop'] }] },
        status: { ephemeralContainerStatuses: [{ name: debugName, state: { running: {} } }] },
      };
    }
    if (path.endsWith('/deployments/web') && !init?.method) {
      return { metadata: { name: 'web', namespace: 'apps', uid: 'deployment-uid' }, spec: {} };
    }
    if (path.includes('/replicasets?') || path.endsWith('/replicasets')) return { items: [] };
    if (path.includes('/replicasets/')) {
      return { metadata: { name: 'web-rs', uid: 'rs-uid', annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: {} };
    }
    return {};
  });
  const handle = {
    raw: { json: raw },
    batch: {
      readNamespacedJob: vi.fn(async () => ({ spec: { template: { spec: { containers: [{ name: 'job', image: 'job:v1' }] } } } })),
      createNamespacedJob: vi.fn(async () => ({})),
    },
    core: { listPodForAllNamespaces: vi.fn(async () => ({ items: [] })) },
    makeExec: () => ({
      exec: vi.fn(async (_ns, _pod, _container, _command, _stdout, _stderr, _stdin, _tty, callback) => {
        callback({ status: 'Success' });
        return new EventEmitter();
      }),
    }),
  } as unknown as ClusterHandle;
  const clusters = {
    get: vi.fn((ctx: string) => {
      if (ctx === 'bad') throw new HttpProblem(409, 'not connected', 'NotConnected');
      return handle;
    }),
  };
  const app = Fastify();
  apps.push(app);
  registerActionRoutes(app, { clusters } as unknown as AppContext);
  await app.ready();
  return { app, raw, handle, clusters };
}

describe('action routes', () => {
  it('dispatches each synchronous workload mutation', async () => {
    const { app, raw } = await harness();
    const requests = [
      ['/api/contexts/kind-a/actions/scale', { group: 'apps', version: 'v1', plural: 'deployments', namespace: 'apps', name: 'web', replicas: 3 }],
      ['/api/contexts/kind-a/actions/rollout-restart', { kind: 'Deployment', namespace: 'apps', name: 'web' }],
      ['/api/contexts/kind-a/actions/cordon', { node: 'worker-1', unschedulable: true }],
      ['/api/contexts/kind-a/actions/rollout-pause', { namespace: 'apps', name: 'web', paused: true }],
      ['/api/contexts/kind-a/actions/suspend-cronjob', { namespace: 'apps', name: 'nightly', suspend: true }],
      [
        '/api/contexts/kind-a/actions/set-image',
        { kind: 'Deployment', namespace: 'apps', name: 'web', container: 'api', image: 'api:v2' },
      ],
    ] as const;
    for (const [url, payload] of requests) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    }
    expect(raw).toHaveBeenCalled();
  });

  it('reruns jobs and starts/stops debug containers', async () => {
    const { app } = await harness();
    const rerun = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/rerun-job',
      payload: { namespace: 'apps', name: 'nightly' },
    });
    expect(rerun.json().jobName).toMatch(/^nightly-rerun-/);

    const debug = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/debug-pod',
      payload: { namespace: 'apps', pod: 'web-0', profile: 'general' },
    });
    expect(debug.statusCode).toBe(200);
    const stopped = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/stop-debug',
      payload: { namespace: 'apps', pod: 'web-0', container: debug.json().containerName },
    });
    expect(stopped.json()).toEqual({ ok: true });
  });

  it('starts asynchronous drains and returns an opaque id', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/drain',
      payload: { node: 'worker-1', gracePeriodSeconds: 10, force: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().drainId).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });

  it('maps helper and connection failures', async () => {
    const { app } = await harness();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/set-image',
      payload: { kind: 'Deployment', namespace: 'apps', name: 'web', container: 'api', image: 'bad image' },
    });
    expect(invalid.statusCode).toBe(422);
    const disconnected = await app.inject({
      method: 'POST',
      url: '/api/contexts/bad/actions/scale',
      payload: { group: 'apps', version: 'v1', plural: 'deployments', namespace: 'apps', name: 'web', replicas: 1 },
    });
    expect(disconnected.statusCode).toBe(409);
  });

  it('surfaces rollout-undo validation errors through the common response shape', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/rollout-undo',
      payload: { kind: 'Deployment', namespace: 'apps', name: 'web' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe('no rollout history found');
  });
});
