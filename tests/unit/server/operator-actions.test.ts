import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperatorActionRequest } from '@kubus/shared';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { runOperatorAction } from '../../../server/src/kube/operator-actions';
import { registerActionRoutes } from '../../../server/src/routes/actions';

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/** A cluster whose GETs return `objects[path]` and whose PATCHes are recorded. */
function fakeHandle(objects: Record<string, unknown> = {}, opts: { noStatusSubresource?: boolean } = {}) {
  const calls: Call[] = [];
  const json = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const hit = objects[path];
      if (!hit) throw Object.assign(new Error('not found'), { code: 404 });
      return hit;
    }
    if (opts.noStatusSubresource && path.endsWith('/status')) throw Object.assign(new Error('not found'), { code: 404 });
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    return {};
  });
  return { handle: { raw: { json } } as unknown as ClusterHandle, calls };
}

const APP = '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/guestbook';
const ROLLOUT = '/apis/argoproj.io/v1alpha1/namespaces/shop/rollouts/checkout';

const app = (extra: Record<string, unknown> = {}): OperatorActionRequest => ({ action: 'argocd-sync', group: 'argoproj.io', version: 'v1alpha1', plural: 'applications', namespace: 'argocd', name: 'guestbook', ...extra });
const rollout = (action: OperatorActionRequest['action']): OperatorActionRequest => ({ action, group: 'argoproj.io', version: 'v1alpha1', plural: 'rollouts', namespace: 'shop', name: 'checkout' });

describe('operator actions', () => {
  it('refreshes and syncs Argo CD Applications the way argocd does', async () => {
    const { handle, calls } = fakeHandle({ [APP]: { metadata: { name: 'guestbook' }, spec: { source: { targetRevision: 'main' } } } });
    await runOperatorAction(handle, app({ action: 'argocd-refresh' }));
    await runOperatorAction(handle, app({ prune: true }));
    expect(calls).toEqual([
      { path: APP, method: 'PATCH', body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } } },
      { path: APP, method: 'PATCH', body: { operation: { initiatedBy: { username: 'kubus' }, sync: { prune: true, revision: 'main' } } } },
    ]);
  });

  it('syncs every source of a multi-source Application and refuses while an operation runs', async () => {
    const multi = fakeHandle({ [APP]: { metadata: { name: 'guestbook' }, spec: { sources: [{ targetRevision: 'v2' }, {}] } } });
    await runOperatorAction(multi.handle, app());
    expect(multi.calls[0]?.body).toEqual({ operation: { initiatedBy: { username: 'kubus' }, sync: { prune: false, revisions: ['v2', 'HEAD'] } } });

    const busy = fakeHandle({ [APP]: { metadata: { name: 'guestbook' }, spec: {}, status: { operationState: { phase: 'Running' } } } });
    await expect(runOperatorAction(busy.handle, app())).rejects.toMatchObject({ statusCode: 409 });
    expect(busy.calls).toEqual([]);
  });

  it('promotes a paused canary by clearing its pause conditions and unpausing the spec', async () => {
    const { handle, calls } = fakeHandle({ [ROLLOUT]: { metadata: { name: 'checkout' }, spec: { paused: true, strategy: { canary: { steps: [{}, {}, {}] } } }, status: { pauseConditions: [{ reason: 'CanaryPauseStep' }], currentStepIndex: 1 } } });
    await runOperatorAction(handle, rollout('rollout-promote'));
    expect(calls).toEqual([
      { path: `${ROLLOUT}/status`, method: 'PATCH', body: { status: { pauseConditions: null } } },
      { path: ROLLOUT, method: 'PATCH', body: { spec: { paused: false } } },
    ]);
  });

  it('steps past an Inconclusive analysis the controller paused on', async () => {
    const { handle, calls } = fakeHandle({
      [ROLLOUT]: {
        metadata: { name: 'checkout' },
        spec: { strategy: { canary: { steps: [{}, {}, {}] } } },
        status: { controllerPause: true, pauseConditions: [{ reason: 'InconclusiveAnalysisRun' }], currentStepIndex: 2, canary: { currentStepAnalysisRunStatus: { status: 'Inconclusive' } } },
      },
    });
    await runOperatorAction(handle, rollout('rollout-promote'));
    expect(calls).toEqual([{ path: `${ROLLOUT}/status`, method: 'PATCH', body: { status: { pauseConditions: null, currentStepIndex: 3 } } }]);
  });

  it('promotes fully, aborts and retries through the status subresource, falling back without one', async () => {
    const { handle, calls } = fakeHandle({ [ROLLOUT]: { metadata: { name: 'checkout' }, spec: {}, status: { currentPodHash: 'new', stableRS: 'old' } } });
    await runOperatorAction(handle, rollout('rollout-promote-full'));
    await runOperatorAction(handle, rollout('rollout-abort'));
    await runOperatorAction(handle, rollout('rollout-retry'));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      [`${ROLLOUT}/status`, { status: { promoteFull: true } }],
      [`${ROLLOUT}/status`, { status: { abort: true } }],
      [`${ROLLOUT}/status`, { status: { abort: false } }],
    ]);

    const legacy = fakeHandle({}, { noStatusSubresource: true });
    await runOperatorAction(legacy.handle, rollout('rollout-abort'));
    expect(legacy.calls).toEqual([{ path: ROLLOUT, method: 'PATCH', body: { status: { abort: true } } }]);

    const promoted = fakeHandle({ [ROLLOUT]: { metadata: { name: 'checkout' }, status: { currentPodHash: 'same', stableRS: 'same' } } });
    await expect(runOperatorAction(promoted.handle, rollout('rollout-promote-full'))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('force-syncs ExternalSecrets and reconciles, suspends and resumes Flux objects with annotations and spec.suspend', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00Z') });
    try {
      const { handle, calls } = fakeHandle();
      const es = { group: 'external-secrets.io', version: 'v1', plural: 'externalsecrets', namespace: 'apps', name: 'db' };
      const ks = { group: 'kustomize.toolkit.fluxcd.io', version: 'v1', plural: 'kustomizations', namespace: 'flux-system', name: 'apps' };
      await runOperatorAction(handle, { action: 'eso-force-sync', ...es });
      await runOperatorAction(handle, { action: 'flux-reconcile', ...ks });
      await runOperatorAction(handle, { action: 'flux-suspend', ...ks });
      await runOperatorAction(handle, { action: 'flux-resume', ...ks });
      const ksPath = '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps';
      expect(calls.map((c) => [c.path, c.body])).toEqual([
        ['/apis/external-secrets.io/v1/namespaces/apps/externalsecrets/db', { metadata: { annotations: { 'force-sync': '1790683200' } } }],
        [ksPath, { metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': '2026-09-29T12:00:00.000Z' } } }],
        [ksPath, { spec: { suspend: true } }],
        [ksPath, { metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': '2026-09-29T12:00:00.000Z' } }, spec: { suspend: false } }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses actions on kinds they were not made for', async () => {
    const { handle, calls } = fakeHandle();
    await expect(runOperatorAction(handle, { action: 'flux-suspend', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'a', name: 'b' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(runOperatorAction(handle, { ...rollout('rollout-abort'), plural: 'applications' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(runOperatorAction(handle, { action: 'nope' as OperatorActionRequest['action'], group: 'argoproj.io', version: 'v1', plural: 'rollouts', namespace: 'a', name: 'b' })).rejects.toMatchObject({ statusCode: 422 });
    expect(calls).toEqual([]);
  });
});

describe('operator action route', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it('dispatches to the cluster and maps refusals to their status codes', async () => {
    const { handle, calls } = fakeHandle();
    const fastify = Fastify();
    apps.push(fastify);
    registerActionRoutes(fastify, { clusters: { get: () => handle } } as unknown as AppContext);
    await fastify.ready();
    const ok = await fastify.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/operator',
      payload: { action: 'flux-reconcile', group: 'helm.toolkit.fluxcd.io', version: 'v2', plural: 'helmreleases', namespace: 'apps', name: 'podinfo' },
    });
    expect(ok.statusCode).toBe(200);
    expect(calls[0]?.path).toBe('/apis/helm.toolkit.fluxcd.io/v2/namespaces/apps/helmreleases/podinfo');
    const refused = await fastify.inject({
      method: 'POST',
      url: '/api/contexts/kind-a/actions/operator',
      payload: { action: 'eso-force-sync', group: 'core', version: 'v1', plural: 'secrets', namespace: 'apps', name: 'db' },
    });
    expect(refused.statusCode).toBe(422);
  });
});
