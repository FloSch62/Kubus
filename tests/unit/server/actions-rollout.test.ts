import { EventEmitter } from 'node:events';
import type { KubeObject } from '@kubus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainNode,
  podContainers,
  rerunJob,
  rolloutRestart,
  scaleResource,
  setCordon,
  setCronJobSuspend,
  setImage,
} from '../../../server/src/kube/actions';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { addDebugContainer, DEFAULT_DEBUG_IMAGE, stopDebugContainer } from '../../../server/src/kube/debug';
import { getRolloutHistory, rolloutUndo, setRolloutPaused } from '../../../server/src/kube/rollout';

function object(name: string, overrides: Record<string, unknown> = {}): KubeObject {
  const metadata = (overrides.metadata ?? {}) as Record<string, unknown>;
  return {
    apiVersion: 'v1',
    kind: 'Unknown',
    ...overrides,
    metadata: { name, namespace: 'apps', uid: `${name}-uid`, ...metadata },
  } as KubeObject;
}

function handleWith(rawJson: ReturnType<typeof vi.fn>, extras: Record<string, unknown> = {}): ClusterHandle {
  return {
    raw: { json: rawJson },
    ...extras,
  } as unknown as ClusterHandle;
}

describe('basic workload actions', () => {
  it('patches scale, restart, suspend, image, pause, and cordon subresources correctly', async () => {
    const raw = vi.fn(async (_path: string, _init?: { body?: string }) => ({}));
    const handle = handleWith(raw);
    vi.setSystemTime('2026-07-22T12:00:00Z');

    await scaleResource(handle, 'apps', 'v1', 'deployments', 'apps', 'web', 4);
    await rolloutRestart(handle, 'Deployment', 'apps', 'web');
    await rolloutRestart(handle, 'StatefulSet', 'apps', 'db');
    await rolloutRestart(handle, 'DaemonSet', 'apps', 'agent');
    await setCronJobSuspend(handle, 'apps', 'nightly', true);
    await setImage(handle, {
      kind: 'Deployment',
      namespace: 'apps',
      name: 'web',
      container: 'api',
      image: 'registry.example.com/api:v2',
    });
    await setImage(handle, {
      kind: 'StatefulSet',
      namespace: 'apps',
      name: 'db',
      container: 'migrate',
      image: 'migrate@sha256:abc',
      initContainer: true,
    });
    await setCordon(handle, 'worker-1', true);
    await setRolloutPaused(handle, 'apps', 'web', true);
    await setRolloutPaused(handle, 'apps', 'web', false);

    expect(raw).toHaveBeenCalledWith(
      '/apis/apps/v1/namespaces/apps/deployments/web/scale',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ spec: { replicas: 4 } }) }),
    );
    expect(raw).toHaveBeenCalledWith(
      '/apis/apps/v1/namespaces/apps/deployments/web',
      expect.objectContaining({ body: expect.stringContaining('2026-07-22T12:00:00.000Z') }),
    );
    expect(raw).toHaveBeenCalledWith(
      '/apis/apps/v1/namespaces/apps/statefulsets/db',
      expect.objectContaining({ body: expect.stringContaining('initContainers') }),
    );
    expect(raw).toHaveBeenCalledWith('/api/v1/nodes/worker-1', expect.objectContaining({ body: '{"spec":{"unschedulable":true}}' }));
    expect(raw.mock.calls.at(-1)?.[1]?.body).toBe('{"spec":{"paused":null}}');
  });

  it.each(['', 'bad image', ' \t'])('rejects invalid image reference %j', async (image) => {
    await expect(
      setImage(handleWith(vi.fn()), {
        kind: 'Deployment',
        namespace: 'apps',
        name: 'web',
        container: 'api',
        image,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('restarts only pods controlled by a ReplicaSet and propagates a delete failure', async () => {
    const rs = object('web-rs', {
      kind: 'ReplicaSet',
      metadata: { name: 'web-rs', namespace: 'apps', uid: 'rs-uid' },
      spec: { selector: { matchLabels: { app: 'web', tier: 'api' } } },
    });
    const controlled = object('web-0', {
      kind: 'Pod',
      metadata: { name: 'web-0', namespace: 'apps', ownerReferences: [{ uid: 'rs-uid', name: 'web-rs', kind: 'ReplicaSet', controller: true }] },
    });
    const unrelated = object('other', {
      kind: 'Pod',
      metadata: { name: 'other', namespace: 'apps', ownerReferences: [{ uid: 'other', name: 'other', kind: 'ReplicaSet', controller: true }] },
    });
    const raw = vi
      .fn()
      .mockResolvedValueOnce(rs)
      .mockResolvedValueOnce({ items: [controlled, unrelated] })
      .mockResolvedValueOnce({});
    await rolloutRestart(handleWith(raw), 'ReplicaSet', 'apps', 'web-rs');
    expect(raw.mock.calls[1]![0]).toContain('labelSelector=app%3Dweb%2Ctier%3Dapi');
    expect(raw.mock.calls[2]![0]).toBe('/api/v1/namespaces/apps/pods/web-0');

    const failing = vi
      .fn()
      .mockResolvedValueOnce(object('empty-rs', { metadata: { name: 'empty-rs', uid: 'rs-uid' }, spec: {} }))
      .mockResolvedValueOnce({ items: [controlled] })
      .mockRejectedValueOnce(new Error('delete denied'));
    await expect(rolloutRestart(handleWith(failing), 'ReplicaSet', 'apps', 'empty-rs')).rejects.toThrow('delete denied');
  });
});

describe('job reruns', () => {
  beforeEach(() => vi.setSystemTime('2026-07-22T12:34:56Z'));

  it('strips controller runtime metadata for generated-selector Jobs', async () => {
    const create = vi.fn(async (_request: {
      body: {
        spec: { selector?: unknown; template: { metadata: { labels?: unknown } } };
        metadata: { labels?: unknown; annotations?: unknown };
      };
    }) => ({}));
    const src = {
      metadata: {
        labels: { app: 'worker', 'controller-uid': 'uid', 'batch.kubernetes.io/job-name': 'old' },
        annotations: {
          keep: 'yes',
          'kubectl.kubernetes.io/last-applied-configuration': '{}',
          'batch.kubernetes.io/job-tracking': 'tracking',
        },
      },
      spec: {
        selector: { matchLabels: { 'controller-uid': 'uid' } },
        template: {
          metadata: { labels: { app: 'worker', 'controller-uid': 'uid', 'job-name': 'old' } },
          spec: { containers: [{ name: 'worker', image: 'worker:v1' }] },
        },
      },
    };
    const handle = handleWith(vi.fn(), {
      batch: { readNamespacedJob: vi.fn(async () => src), createNamespacedJob: create },
    });
    const result = await rerunJob(handle, 'apps', 'nightly');
    expect(result.jobName).toBe('nightly-rerun-1784723696');
    const body = create.mock.calls[0]![0].body;
    expect(body.spec.selector).toBeUndefined();
    expect(body.metadata.labels).toEqual({ app: 'worker' });
    expect(body.spec.template.metadata.labels).toEqual({ app: 'worker' });
    expect(body.metadata.annotations).toEqual({ keep: 'yes', 'kubus.io/rerun-of': 'nightly' });
  });

  it('preserves manual selectors, omits empty labels, truncates names, and rejects missing specs', async () => {
    const create = vi.fn(async (_request: {
      body: { spec: { selector?: unknown }; metadata: { labels?: unknown } };
    }) => ({}));
    const manual = {
      metadata: { labels: {}, annotations: {} },
      spec: { manualSelector: true, selector: { matchLabels: { manual: 'yes' } }, template: { metadata: { labels: { manual: 'yes' } } } },
    };
    const batch = { readNamespacedJob: vi.fn(async () => manual), createNamespacedJob: create };
    const result = await rerunJob(handleWith(vi.fn(), { batch }), 'apps', 'a'.repeat(60));
    expect(result.jobName).toHaveLength(63);
    expect(create.mock.calls[0]![0].body.spec.selector).toEqual({ matchLabels: { manual: 'yes' } });
    expect(create.mock.calls[0]![0].body.metadata.labels).toBeUndefined();

    batch.readNamespacedJob.mockResolvedValueOnce({ metadata: {} } as unknown as typeof manual);
    await expect(rerunJob(handleWith(vi.fn(), { batch }), 'apps', 'broken')).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('node drain', () => {
  function drainHandle(evict: (path: string, init?: unknown) => unknown): ClusterHandle {
    const pods = [
      { metadata: { name: 'workload', namespace: 'apps' }, status: { phase: 'Running' } },
      {
        metadata: { name: 'daemon', namespace: 'apps', ownerReferences: [{ kind: 'DaemonSet', controller: true }] },
        status: { phase: 'Running' },
      },
      { metadata: { name: 'mirror', namespace: 'kube-system', annotations: { 'kubernetes.io/config.mirror': 'hash' } }, status: { phase: 'Running' } },
      { metadata: { name: 'done', namespace: 'apps' }, status: { phase: 'Succeeded' } },
      { metadata: { name: 'failed', namespace: 'apps' }, status: { phase: 'Failed' } },
    ];
    const raw = vi.fn(async (path: string, init?: unknown) => {
      if (path.includes('/eviction')) return evict(path, init);
      return {};
    });
    return handleWith(raw, { core: { listPodForAllNamespaces: vi.fn(async () => ({ items: pods })) } });
  }

  it('cordons, filters protected pods, evicts workloads, and reports progress', async () => {
    const evict = vi.fn().mockResolvedValueOnce({});
    const progress = vi.fn();
    await drainNode(drainHandle(evict), 'worker-1', { gracePeriodSeconds: 30 }, progress);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ body: expect.stringContaining('"gracePeriodSeconds":30') }),
    );
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { evicted: 0, total: 1 },
      { evicted: 0, total: 1, current: 'apps/workload' },
      { evicted: 1, total: 1 },
      { evicted: 1, total: 1, done: true },
    ]);
  });

  it('treats missing pods as evicted and maps terminal errors to HTTP problems', async () => {
    const progress = vi.fn();
    await drainNode(drainHandle(vi.fn().mockRejectedValue({ code: 404 })), 'worker', {}, progress);
    expect(progress).toHaveBeenLastCalledWith({ evicted: 1, total: 1, done: true });

    await expect(drainNode(drainHandle(vi.fn().mockRejectedValue(new Error('admission denied'))), 'worker', {}, vi.fn())).rejects.toMatchObject({
      statusCode: 500,
      message: 'failed to evict apps/workload: admission denied',
    });
    await expect(drainNode(drainHandle(vi.fn().mockRejectedValue({ code: 403 })), 'worker', {}, vi.fn())).rejects.toMatchObject({ statusCode: 403 });

    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001);
    await expect(drainNode(drainHandle(vi.fn().mockRejectedValue({ code: 429 })), 'worker', {}, vi.fn())).rejects.toMatchObject({ statusCode: 429 });
    now.mockRestore();
  });
});

describe('rollout history and undo', () => {
  function owner(uid: string) {
    return [{ apiVersion: 'apps/v1', uid, name: 'owner', kind: 'Deployment', controller: true }];
  }

  it('builds sorted Deployment history from owned ReplicaSets', async () => {
    const deployment = object('web', {
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'apps', uid: 'deployment-uid', annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { selector: { matchLabels: { app: 'web' } } },
    });
    const old = object('web-old', {
      kind: 'ReplicaSet',
      metadata: {
        name: 'web-old',
        namespace: 'apps',
        ownerReferences: owner('deployment-uid'),
        annotations: { 'deployment.kubernetes.io/revision': '1', 'kubernetes.io/change-cause': 'initial' },
        creationTimestamp: '2026-01-01T00:00:00Z',
      },
      spec: { template: { spec: { initContainers: [{ image: 'init:v1' }], containers: [{ image: 'app:v1' }, {}] } } },
      status: { replicas: 0 },
    });
    const current = object('web-current', {
      kind: 'ReplicaSet',
      metadata: { name: 'web-current', namespace: 'apps', ownerReferences: owner('deployment-uid'), annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { template: { spec: { containers: [{ image: 'app:v2' }] } } },
      status: { replicas: 3 },
    });
    const unrelated = object('other', { metadata: { name: 'other', ownerReferences: owner('other-uid') } });
    const raw = vi.fn().mockResolvedValueOnce(deployment).mockResolvedValueOnce({ items: [old, unrelated, current] });
    const history = await getRolloutHistory(handleWith(raw), 'Deployment', 'apps', 'web');
    expect(history).toEqual([
      expect.objectContaining({ revision: 2, name: 'web-current', current: true, images: ['app:v2'], replicas: 3 }),
      expect.objectContaining({ revision: 1, name: 'web-old', current: false, images: ['init:v1', 'app:v1'], changeCause: 'initial' }),
    ]);
    expect(raw.mock.calls[1]![0]).toContain('labelSelector=app%3Dweb');
  });

  it('marks StatefulSet update revisions and newest DaemonSet revisions current', async () => {
    const children = [
      object('rev-1', {
        metadata: { name: 'rev-1', ownerReferences: owner('uid') },
        revision: 1,
        data: { spec: { template: { spec: { containers: [{ image: 'app:v1' }] } } } },
      }),
      object('rev-2', {
        metadata: { name: 'rev-2', ownerReferences: owner('uid') },
        revision: 2,
        data: { spec: { template: { spec: { containers: [{ image: 'app:v2' }] } } } },
      }),
    ];
    const stateful = object('db', { kind: 'StatefulSet', metadata: { name: 'db', uid: 'uid' }, status: { updateRevision: 'rev-1' } });
    let raw = vi.fn().mockResolvedValueOnce(stateful).mockResolvedValueOnce({ items: children });
    expect(await getRolloutHistory(handleWith(raw), 'StatefulSet', 'apps', 'db')).toEqual([
      expect.objectContaining({ revision: 2, current: false }),
      expect.objectContaining({ revision: 1, current: true }),
    ]);

    const daemon = object('agent', { kind: 'DaemonSet', metadata: { name: 'agent', uid: 'uid' } });
    raw = vi.fn().mockResolvedValueOnce(daemon).mockResolvedValueOnce({ items: children });
    expect(await getRolloutHistory(handleWith(raw), 'DaemonSet', 'apps', 'agent')).toEqual([
      expect.objectContaining({ revision: 2, current: true }),
      expect.objectContaining({ revision: 1, current: false }),
    ]);
  });

  it('undoes Deployment and controller-revision rollouts with sanitized patches', async () => {
    const deployment = object('web', {
      metadata: { name: 'web', uid: 'deployment-uid', annotations: { 'deployment.kubernetes.io/revision': '2' } },
    });
    const oldRs = object('web-old', {
      metadata: { name: 'web-old', ownerReferences: owner('deployment-uid'), annotations: { 'deployment.kubernetes.io/revision': '1' } },
      spec: { template: { metadata: { labels: { app: 'web', 'pod-template-hash': 'old' } }, spec: { containers: [{ image: 'app:v1' }] } } },
    });
    const currentRs = object('web-current', {
      metadata: { name: 'web-current', ownerReferences: owner('deployment-uid'), annotations: { 'deployment.kubernetes.io/revision': '2' } },
    });
    const raw = vi
      .fn()
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ items: [oldRs, currentRs] })
      .mockResolvedValueOnce(oldRs)
      .mockResolvedValueOnce({});
    await rolloutUndo(handleWith(raw), 'Deployment', 'apps', 'web');
    expect(JSON.parse(raw.mock.calls[3]![1].body).spec.template.metadata.labels).toEqual({ app: 'web' });

    const stateful = object('db', { metadata: { name: 'db', uid: 'uid' }, status: { updateRevision: 'rev-2' } });
    const rev1 = object('rev-1', { metadata: { name: 'rev-1', ownerReferences: owner('uid') }, revision: 1 });
    const rev2 = object('rev-2', { metadata: { name: 'rev-2', ownerReferences: owner('uid') }, revision: 2 });
    const controllerRevision = { ...rev1, data: { spec: { template: { spec: { containers: [{ image: 'db:v1' }] } } } } };
    const statefulRaw = vi
      .fn()
      .mockResolvedValueOnce(stateful)
      .mockResolvedValueOnce({ items: [rev1, rev2] })
      .mockResolvedValueOnce(controllerRevision)
      .mockResolvedValueOnce({});
    await rolloutUndo(handleWith(statefulRaw), 'StatefulSet', 'apps', 'db', 1);
    expect(statefulRaw.mock.calls[3]![0]).toContain('/statefulsets/db');
    expect(JSON.parse(statefulRaw.mock.calls[3]![1].body)).toEqual(controllerRevision.data);
  });

  it('rejects missing, unknown, current-only, and data-less revisions', async () => {
    const emptyWorkload = object('web', { metadata: { name: 'web', uid: 'uid' } });
    await expect(
      rolloutUndo(handleWith(vi.fn().mockResolvedValueOnce(emptyWorkload).mockResolvedValueOnce({ items: [] })), 'Deployment', 'apps', 'web'),
    ).rejects.toMatchObject({ statusCode: 404 });

    const current = object('web-current', {
      metadata: { name: 'web-current', ownerReferences: owner('uid'), annotations: { 'deployment.kubernetes.io/revision': '2' } },
    });
    const workload = object('web', { metadata: { name: 'web', uid: 'uid', annotations: { 'deployment.kubernetes.io/revision': '2' } } });
    await expect(
      rolloutUndo(handleWith(vi.fn().mockResolvedValueOnce(workload).mockResolvedValueOnce({ items: [current] })), 'Deployment', 'apps', 'web'),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      rolloutUndo(handleWith(vi.fn().mockResolvedValueOnce(workload).mockResolvedValueOnce({ items: [current] })), 'Deployment', 'apps', 'web', 9),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      rolloutUndo(handleWith(vi.fn().mockResolvedValueOnce(workload).mockResolvedValueOnce({ items: [current] })), 'Deployment', 'apps', 'web', 2),
    ).rejects.toMatchObject({ statusCode: 422 });

    const stateful = object('db', { metadata: { name: 'db', uid: 'uid' }, status: { updateRevision: 'rev-2' } });
    const old = object('rev-1', { metadata: { name: 'rev-1', ownerReferences: owner('uid') }, revision: 1 });
    const currentCr = object('rev-2', { metadata: { name: 'rev-2', ownerReferences: owner('uid') }, revision: 2 });
    await expect(
      rolloutUndo(
        handleWith(vi.fn().mockResolvedValueOnce(stateful).mockResolvedValueOnce({ items: [old, currentCr] }).mockResolvedValueOnce(old)),
        'StatefulSet',
        'apps',
        'db',
        1,
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'controller revision has no data' });
  });
});

describe('debug containers', () => {
  function execHandle(raw: ReturnType<typeof vi.fn>, outcome: { code: number; stderr?: string } = { code: 0 }): ClusterHandle {
    return handleWith(raw, {
      makeExec: () => ({
        exec: vi.fn(async (_namespace, _pod, _container, _command, _stdout, stderr, _stdin, _tty, callback) => {
          if (outcome.stderr) stderr.write(outcome.stderr);
          callback({
            status: outcome.code === 0 ? 'Success' : 'Failure',
            details: outcome.code === 0 ? undefined : { causes: [{ reason: 'ExitCode', message: String(outcome.code) }] },
          });
          return new EventEmitter();
        }),
      }),
    });
  }

  it.each(['general', 'restricted', 'netadmin', 'sysadmin'] as const)('adds a running %s ephemeral container', async (profile) => {
    let generated = '';
    const raw = vi.fn(async (_path: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(init.body!);
        generated = patch.spec.ephemeralContainers[0].name;
        expect(patch.spec.ephemeralContainers[0].image).toBe(DEFAULT_DEBUG_IMAGE);
        return {};
      }
      return { status: { ephemeralContainerStatuses: [{ name: generated, state: { running: {} } }] } };
    });
    const result = await addDebugContainer(execHandle(raw), { namespace: 'apps', pod: 'web-0', profile, target: 'app' });
    expect(result.containerName).toMatch(/^debug-[a-z0-9]{6}$/);
    expect(raw.mock.calls[0]![0]).toContain('/ephemeralcontainers');
  });

  it('validates images/profiles and explains unsupported clusters', async () => {
    await expect(addDebugContainer(execHandle(vi.fn()), { namespace: 'apps', pod: 'web', image: 'bad image' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      addDebugContainer(execHandle(vi.fn()), { namespace: 'apps', pod: 'web', profile: 'unknown' as 'general' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      addDebugContainer(execHandle(vi.fn().mockRejectedValue({ code: 404 })), { namespace: 'apps', pod: 'web' }),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('does not support ephemeral containers') });
    await expect(
      addDebugContainer(execHandle(vi.fn().mockRejectedValue(new Error('denied'))), { namespace: 'apps', pod: 'web' }),
    ).rejects.toThrow('denied');
  });

  it('stops compatible debug containers and treats exit 137/143 as success', async () => {
    for (const code of [0, 137, 143]) {
      const raw = vi.fn(async () => ({
        spec: { ephemeralContainers: [{ name: 'debug-one', command: ['sh', '-c', 'while [ ! -e /tmp/.kubus-stop ]; do sleep 1; done'] }] },
      }));
      await expect(
        stopDebugContainer(execHandle(raw, { code }), { namespace: 'apps', pod: 'web', container: 'debug-one' }),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects missing/legacy debug containers and command failures', async () => {
    await expect(
      stopDebugContainer(execHandle(vi.fn(async () => ({ spec: {} }))), { namespace: 'apps', pod: 'web', container: 'missing' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      stopDebugContainer(
        execHandle(vi.fn(async () => ({ spec: { ephemeralContainers: [{ name: 'old', command: ['sleep', '3600'] }] } }))),
        { namespace: 'apps', pod: 'web', container: 'old' },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      stopDebugContainer(
        execHandle(
          vi.fn(async () => ({ spec: { ephemeralContainers: [{ name: 'debug', command: ['/tmp/.kubus-stop'] }] } })),
          { code: 2, stderr: 'touch denied' },
        ),
        { namespace: 'apps', pod: 'web', container: 'debug' },
      ),
    ).rejects.toMatchObject({ statusCode: 500, message: 'touch denied' });
  });
});

describe('podContainers', () => {
  it('combines regular and init containers and tolerates missing specs', () => {
    expect(
      podContainers(object('pod', { spec: { containers: [{ name: 'app' }, { name: 'sidecar' }], initContainers: [{ name: 'init' }] } })),
    ).toEqual(['app', 'sidecar', 'init']);
    expect(podContainers(object('empty'))).toEqual([]);
  });
});
