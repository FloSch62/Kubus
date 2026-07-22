import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { resolveTargetPods, selectorToString } from '../../../server/src/kube/target-pods.js';

/** Routes raw.json calls by path prefix; unmatched paths fail the test. */
function fakeHandle(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const handle = {
    raw: {
      json: (path: string): Promise<unknown> => {
        calls.push(path);
        for (const [prefix, value] of Object.entries(responses)) {
          if (path.startsWith(prefix)) return Promise.resolve(value);
        }
        return Promise.reject(new Error(`unexpected request: ${path}`));
      },
    },
  };
  return { calls, handle: handle as unknown as ClusterHandle };
}

function labelSelectorOf(path: string | undefined): string | null {
  if (!path) return null;
  return new URL(`http://cluster${path}`).searchParams.get('labelSelector');
}

function pod(name: string, owners?: Array<{ kind: string; uid: string; controller?: boolean }>): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'ops',
      uid: `uid-${name}`,
      ownerReferences: owners?.map((o) => ({ apiVersion: 'apps/v1', kind: o.kind, name: 'owner', uid: o.uid, controller: o.controller })),
    },
  };
}

function replicaSet(name: string, ownerUid: string, controller = true): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name,
      namespace: 'ops',
      uid: `uid-${name}`,
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: ownerUid, controller }],
    },
  };
}

describe('selectorToString', () => {
  it('returns undefined for missing or empty selectors', () => {
    expect(selectorToString(undefined)).toBeUndefined();
    expect(selectorToString({})).toBeUndefined();
    expect(selectorToString({ matchLabels: {}, matchExpressions: [] })).toBeUndefined();
  });

  it('formats matchLabels as equality terms', () => {
    expect(selectorToString({ matchLabels: { app: 'web', tier: 'front' } })).toBe('app=web,tier=front');
  });

  it('formats every matchExpressions operator', () => {
    expect(selectorToString({ matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'staging'] }] })).toBe('env in (prod,staging)');
    expect(selectorToString({ matchExpressions: [{ key: 'env', operator: 'NotIn', values: ['dev'] }] })).toBe('env notin (dev)');
    expect(selectorToString({ matchExpressions: [{ key: 'gpu', operator: 'Exists' }] })).toBe('gpu');
    expect(selectorToString({ matchExpressions: [{ key: 'canary', operator: 'DoesNotExist' }] })).toBe('!canary');
    expect(selectorToString({ matchExpressions: [{ key: 'env', operator: 'In' }] })).toBe('env in ()');
  });

  it('combines labels and expressions, labels first', () => {
    const selector = {
      matchLabels: { app: 'web' },
      matchExpressions: [{ key: 'env', operator: 'In' as const, values: ['prod'] }, { key: 'canary', operator: 'DoesNotExist' as const }],
    };
    expect(selectorToString(selector)).toBe('app=web,env in (prod),!canary');
  });
});

describe('resolveTargetPods', () => {
  it('returns a bare Pod target directly without any API calls', async () => {
    const { calls, handle } = fakeHandle({});
    const target = pod('api-0');

    const pods = await resolveTargetPods(handle, target, 'Pod', 'ops');

    expect(pods).toEqual([target]);
    expect(calls).toEqual([]);
  });

  it('resolves Service targets by label selector without ownership filtering', async () => {
    const orphan = pod('orphan');
    const owned = pod('web-abc', [{ kind: 'ReplicaSet', uid: 'uid-rs', controller: true }]);
    const { calls, handle } = fakeHandle({ '/api/v1/namespaces/ops/pods': { items: [orphan, owned] } });
    const service: KubeObject = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'web', namespace: 'ops', uid: 'svc-uid' },
      spec: { selector: { app: 'web', tier: 'front' } },
    };

    const pods = await resolveTargetPods(handle, service, 'Service', 'ops');

    expect(pods).toEqual([orphan, owned]);
    expect(calls).toHaveLength(1);
    expect(labelSelectorOf(calls[0])).toBe('app=web,tier=front');
  });

  it('returns no pods for a Service without a selector', async () => {
    const { calls, handle } = fakeHandle({});
    const service: KubeObject = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'headless', namespace: 'ops', uid: 'svc-uid' }, spec: {} };

    expect(await resolveTargetPods(handle, service, 'Service', 'ops')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('resolves Deployment pods through controller-owned ReplicaSets only', async () => {
    const deployment: KubeObject = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'ops', uid: 'deploy-uid' },
      spec: { selector: { matchLabels: { app: 'web' } } },
    };
    const rsCurrent = replicaSet('web-6789', 'deploy-uid');
    const rsPrevious = replicaSet('web-1234', 'deploy-uid');
    const rsForeign = replicaSet('other-1111', 'other-deploy-uid');
    const rsNonController = replicaSet('web-adopted', 'deploy-uid', false);

    const podCurrent = pod('web-6789-a', [{ kind: 'ReplicaSet', uid: 'uid-web-6789', controller: true }]);
    const podPrevious = pod('web-1234-a', [{ kind: 'ReplicaSet', uid: 'uid-web-1234', controller: true }]);
    const podForeign = pod('other-1111-a', [{ kind: 'ReplicaSet', uid: 'uid-other-1111', controller: true }]);
    const podOrphan = pod('lookalike');
    const podNonController = pod('web-6789-b', [{ kind: 'ReplicaSet', uid: 'uid-web-6789', controller: false }]);

    const { calls, handle } = fakeHandle({
      '/apis/apps/v1/namespaces/ops/replicasets': { items: [rsCurrent, rsPrevious, rsForeign, rsNonController] },
      '/api/v1/namespaces/ops/pods': { items: [podCurrent, podPrevious, podForeign, podOrphan, podNonController] },
    });

    const pods = await resolveTargetPods(handle, deployment, 'Deployment', 'ops');

    // Pods from both live generations survive; label lookalikes do not.
    expect(pods.map((p) => p.metadata.name)).toEqual(['web-6789-a', 'web-1234-a']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/apis/apps/v1/namespaces/ops/replicasets?');
    expect(labelSelectorOf(calls[0])).toBe('app=web');
    expect(calls[1]).toContain('/api/v1/namespaces/ops/pods?');
    expect(labelSelectorOf(calls[1])).toBe('app=web');
  });

  it('resolves Job pods by direct controller ownership', async () => {
    const job: KubeObject = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'report', namespace: 'ops', uid: 'job-uid' },
      spec: { selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': 'job-uid' } } },
    };
    const owned = pod('report-a', [{ kind: 'Job', uid: 'job-uid', controller: true }]);
    const foreign = pod('other-a', [{ kind: 'Job', uid: 'other-job-uid', controller: true }]);
    const adopted = pod('report-b', [{ kind: 'Job', uid: 'job-uid', controller: false }]);
    const { calls, handle } = fakeHandle({ '/api/v1/namespaces/ops/pods': { items: [owned, foreign, adopted] } });

    const pods = await resolveTargetPods(handle, job, 'Job', 'ops');

    expect(pods).toEqual([owned]);
    expect(labelSelectorOf(calls[0])).toBe('batch.kubernetes.io/controller-uid=job-uid');
  });

  it('still filters Job pods by ownership when the Job has no selector', async () => {
    const job: KubeObject = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'report', namespace: 'ops', uid: 'job-uid' } };
    const owned = pod('report-a', [{ kind: 'Job', uid: 'job-uid', controller: true }]);
    const other = pod('unrelated');
    const { calls, handle } = fakeHandle({ '/api/v1/namespaces/ops/pods': { items: [owned, other] } });

    const pods = await resolveTargetPods(handle, job, 'Job', 'ops');

    expect(pods).toEqual([owned]);
    expect(calls).toEqual(['/api/v1/namespaces/ops/pods']);
  });

  it('resolves StatefulSet pods by direct controller ownership', async () => {
    const sts: KubeObject = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'db', namespace: 'ops', uid: 'sts-uid' },
      spec: { selector: { matchLabels: { app: 'db' } } },
    };
    const owned = pod('db-0', [{ kind: 'StatefulSet', uid: 'sts-uid', controller: true }]);
    const foreign = pod('db-imposter', [{ kind: 'StatefulSet', uid: 'other-uid', controller: true }]);
    const orphan = pod('db-orphan');
    const { calls, handle } = fakeHandle({ '/api/v1/namespaces/ops/pods': { items: [owned, foreign, orphan] } });

    const pods = await resolveTargetPods(handle, sts, 'StatefulSet', 'ops');

    expect(pods).toEqual([owned]);
    expect(labelSelectorOf(calls[0])).toBe('app=db');
  });

  it('returns no pods for a selector-driven workload without a selector', async () => {
    const { calls, handle } = fakeHandle({});
    const sts: KubeObject = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'db', namespace: 'ops', uid: 'sts-uid' }, spec: {} };

    expect(await resolveTargetPods(handle, sts, 'StatefulSet', 'ops')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('passes matchExpressions selectors through to the pod list query', async () => {
    const ds: KubeObject = {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'agent', namespace: 'ops', uid: 'ds-uid' },
      spec: {
        selector: {
          matchExpressions: [
            { key: 'env', operator: 'In', values: ['prod', 'staging'] },
            { key: 'canary', operator: 'DoesNotExist' },
          ],
        },
      },
    };
    const { calls, handle } = fakeHandle({ '/api/v1/namespaces/ops/pods': { items: [] } });

    expect(await resolveTargetPods(handle, ds, 'DaemonSet', 'ops')).toEqual([]);
    expect(labelSelectorOf(calls[0])).toBe('env in (prod,staging),!canary');
  });
});
