import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  builtinInventoryHealth,
  customInventoryHealth,
  healthFromIssues,
  issueGrade,
  podGrade,
  replicaSetGrade,
} from '../../../server/src/kube/inventory-health.js';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { computeNamespaceOverview } from '../../../server/src/kube/namespace-overview.js';
import { HEALTH_KINDS, computeWorkloadHealth } from '../../../server/src/kube/workload-health.js';

const now = Date.parse('2026-09-29T12:00:00Z');

function obj(name: string, body: { spec?: Record<string, unknown>; status?: Record<string, unknown>; created?: string } = {}): KubeObject {
  return {
    metadata: { name, namespace: 'gap', uid: name, creationTimestamp: body.created ?? '2026-09-29T11:59:00Z' },
    ...(body.spec ? { spec: body.spec } : {}),
    ...(body.status ? { status: body.status } : {}),
  } as KubeObject;
}

const ready = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] };

describe('issueGrade', () => {
  it('fails workloads with nothing ready and degrades partial ones', () => {
    expect(issueGrade({ kind: 'Deployment', namespace: 'gap', name: 'a', ready: 0, desired: 2 })).toBe('failed');
    expect(issueGrade({ kind: 'StatefulSet', namespace: 'gap', name: 'b', ready: 1, desired: 2 })).toBe('degraded');
  });

  it('grades by reason where the kind has one', () => {
    expect(issueGrade({ kind: 'Job', namespace: 'gap', name: 'j', reason: 'BackoffLimitExceeded' })).toBe('failed');
    expect(issueGrade({ kind: 'PersistentVolumeClaim', namespace: 'gap', name: 'p', reason: 'Pending' })).toBe('degraded');
    expect(issueGrade({ kind: 'PersistentVolumeClaim', namespace: 'gap', name: 'p', reason: 'Lost' })).toBe('failed');
    expect(issueGrade({ kind: 'ResourceQuota', namespace: 'gap', name: 'q', reason: 'NearQuota' })).toBe('degraded');
    expect(issueGrade({ kind: 'ResourceQuota', namespace: 'gap', name: 'q', reason: 'AtQuota' })).toBe('failed');
    expect(issueGrade({ kind: 'PodDisruptionBudget', namespace: 'gap', name: 'b', reason: 'NoDisruptionsAllowed' })).toBe('degraded');
  });

  it('counts objects without an issue as healthy', () => {
    const issues = [
      { kind: 'Deployment', namespace: 'gap', name: 'a', ready: 0, desired: 1 },
      { kind: 'Deployment', namespace: 'gap', name: 'b', ready: 1, desired: 3 },
    ];
    expect(healthFromIssues(5, issues)).toEqual({ healthy: 3, degraded: 1, failed: 1 });
  });
});

describe('podGrade', () => {
  it('splits pods into ready, converging and failing', () => {
    expect(podGrade(obj('ok', { status: ready }), now)).toBe('healthy');
    expect(podGrade(obj('done', { status: { phase: 'Succeeded' } }), now)).toBe('healthy');
    expect(podGrade(obj('unready', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } }), now)).toBe('degraded');
    expect(podGrade(obj('young', { status: { phase: 'Pending' } }), now)).toBe('degraded');
    expect(podGrade(obj('stuck', { status: { phase: 'Pending' }, created: '2026-09-29T11:00:00Z' }), now)).toBe('failed');
    const crashing = obj('crash', { status: { phase: 'Running', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });
    expect(podGrade(crashing, now)).toBe('failed');
  });
});

describe('replicaSetGrade', () => {
  it('treats scaled-down revisions as healthy', () => {
    expect(replicaSetGrade(obj('old', { spec: { replicas: 0 } }))).toBe('healthy');
    expect(replicaSetGrade(obj('full', { spec: { replicas: 2 }, status: { availableReplicas: 2 } }))).toBe('healthy');
    expect(replicaSetGrade(obj('half', { spec: { replicas: 2 }, status: { availableReplicas: 1 } }))).toBe('degraded');
    expect(replicaSetGrade(obj('none', { spec: { replicas: 2 } }))).toBe('failed');
  });
});

describe('builtinInventoryHealth', () => {
  it('reuses the workload checkers for the kinds they cover', () => {
    const spec = HEALTH_KINDS.find((k) => k.kind === 'Deployment')!;
    const deployments = [
      obj('web', { spec: { replicas: 2 }, status: { availableReplicas: 2 } }),
      obj('api', { spec: { replicas: 2 }, status: { availableReplicas: 1 } }),
      obj('broken', { spec: { replicas: 1 } }),
    ];
    const { issues } = computeWorkloadHealth([{ spec, items: deployments, unavailable: false }]);
    expect(builtinInventoryHealth('Deployment', deployments, issues, now)).toEqual({ healthy: 1, degraded: 1, failed: 1 });
  });

  it('checks pods and ReplicaSets itself and leaves plain kinds without a bar', () => {
    expect(builtinInventoryHealth('Pod', [obj('a', { status: ready }), obj('b', { status: { phase: 'Failed' } })], [], now)).toEqual({ healthy: 1, degraded: 0, failed: 1 });
    expect(builtinInventoryHealth('ReplicaSet', [obj('rs', { spec: { replicas: 0 } })], [], now)).toEqual({ healthy: 1, degraded: 0, failed: 0 });
    expect(builtinInventoryHealth('ConfigMap', [obj('cm')], [], now)).toBeUndefined();
    expect(builtinInventoryHealth('Service', [obj('svc')], [], now)).toBeUndefined();
  });
});

describe('customInventoryHealth', () => {
  it('grades Ready-condition operators and leaves unreconciled objects alone', () => {
    const certs = [
      obj('ok', { status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
      obj('issuing', { status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } }),
      obj('broken', { status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Failed' }] } }),
      obj('new'),
    ];
    expect(customInventoryHealth('certificates.cert-manager.io', certs)).toEqual({ healthy: 2, degraded: 1, failed: 1 });
  });

  it('grades Argo applications by health status', () => {
    const apps = [
      obj('synced', { status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } } }),
      obj('drift', { status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' } } }),
      obj('down', { status: { health: { status: 'Degraded' }, sync: { status: 'Synced' } } }),
    ];
    expect(customInventoryHealth('applications.argoproj.io', apps)).toEqual({ healthy: 1, degraded: 1, failed: 1 });
  });

  it('fails HTTPRoutes a parent rejected', () => {
    const routes = [
      obj('attached', { status: { parents: [{ conditions: [{ type: 'Accepted', status: 'True' }, { type: 'ResolvedRefs', status: 'True' }] }] } }),
      obj('bad-ref', { status: { parents: [{ conditions: [{ type: 'Accepted', status: 'True' }, { type: 'ResolvedRefs', status: 'False' }] }] } }),
      obj('no-controller'),
    ];
    expect(customInventoryHealth('httproutes.gateway.networking.k8s.io', routes)).toEqual({ healthy: 2, degraded: 0, failed: 1 });
  });

  it('has no bar for CRDs without a known status shape', () => {
    expect(customInventoryHealth('servicemonitors.monitoring.coreos.com', [obj('sm')])).toBeUndefined();
  });
});

describe('computeNamespaceOverview inventory health', () => {
  function fakeHandle(objects: Record<string, KubeObject[]>): ClusterHandle {
    return {
      watchers: {
        acquire: (_group: string, _version: string, plural: string) => ({
          watcher: { ready: async () => {}, items: () => objects[plural] ?? [], currentState: () => 'live' },
          release: () => {},
        }),
      },
      discovery: { getResources: async () => [] },
    } as unknown as ClusterHandle;
  }

  it('attaches a health split to kinds that have one, custom resources included', async () => {
    const inNs = (o: KubeObject) => ({ ...o, metadata: { ...o.metadata, namespace: 'gap' } });
    const crd = {
      metadata: { name: 'certificates.cert-manager.io' },
      spec: { group: 'cert-manager.io', scope: 'Namespaced', names: { kind: 'Certificate', plural: 'certificates' }, versions: [{ name: 'v1', served: true, storage: true }] },
    } as unknown as KubeObject;
    const handle = fakeHandle({
      namespaces: [{ metadata: { name: 'gap' }, status: { phase: 'Active' } } as unknown as KubeObject],
      customresourcedefinitions: [crd],
      pods: [obj('a', { status: ready }), obj('b', { status: { phase: 'Failed' } })].map(inNs),
      deployments: [obj('web', { spec: { replicas: 1 } })].map(inNs),
      configmaps: [obj('cm')].map(inNs),
      certificates: [obj('tls', { status: { conditions: [{ type: 'Ready', status: 'False' }] } })].map(inNs),
    });
    const overview = await computeNamespaceOverview(handle, ['gap']);
    const entry = (kind: string) => overview.inventory.find((e) => e.kind === kind);
    expect(entry('Pod')).toMatchObject({ total: 2, health: { healthy: 1, degraded: 0, failed: 1 } });
    expect(entry('Deployment')).toMatchObject({ total: 1, health: { healthy: 0, degraded: 0, failed: 1 } });
    expect(entry('ConfigMap')?.health).toBeUndefined();
    expect(entry('Certificate')).toMatchObject({ custom: true, total: 1, health: { healthy: 0, degraded: 0, failed: 1 } });
  });
});
