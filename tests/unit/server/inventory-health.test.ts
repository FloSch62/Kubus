import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { gradeBuiltinKind, gradeCustomKind, issueGrade, podVerdict, replicaSetVerdict } from '../../../server/src/kube/inventory-health.js';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager.js';
import { computeNamespaceOverview } from '../../../server/src/kube/namespace-overview.js';
import { computeOperatorRollups } from '../../../server/src/kube/operator-rollups.js';
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
const podSpec = { kind: 'Pod', group: '', version: 'v1', plural: 'pods' };
const certSpec = { kind: 'Certificate', group: 'cert-manager.io', version: 'v1', plural: 'certificates' };
const routeSpec = { kind: 'HTTPRoute', group: 'gateway.networking.k8s.io', version: 'v1', plural: 'httproutes' };

function rejectedRoute(name: string): KubeObject {
  return obj(name, {
    status: {
      parents: [
        {
          parentRef: { name: 'missing-gw' },
          conditions: [{ type: 'Accepted', status: 'False', reason: 'NoMatchingParent', message: 'Gateway missing-gw not found' }],
        },
      ],
    },
  });
}

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
});

describe('podVerdict', () => {
  it('splits pods into ready, converging and failing, with the reason', () => {
    expect(podVerdict(obj('ok', { status: ready }), now)).toEqual({ grade: 'healthy' });
    expect(podVerdict(obj('done', { status: { phase: 'Succeeded' } }), now)).toEqual({ grade: 'healthy' });
    expect(podVerdict(obj('unready', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False', message: 'containers with unready status: [app]' }] } }), now)).toEqual({
      grade: 'degraded',
      reason: 'NotReady',
      message: 'containers with unready status: [app]',
    });
    const creating = obj('creating', { status: { phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] } });
    expect(podVerdict(creating, now)).toMatchObject({ grade: 'degraded', reason: 'ContainerCreating' });
    const unschedulable = obj('young', { status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes are available' }] } });
    expect(podVerdict(unschedulable, now)).toMatchObject({ grade: 'degraded', reason: 'Unschedulable', message: '0/1 nodes are available' });
    expect(podVerdict(obj('stuck', { status: { phase: 'Pending' }, created: '2026-09-29T11:00:00Z' }), now)).toMatchObject({ grade: 'failed', reason: 'Pending' });
    const crashing = obj('crash', { status: { phase: 'Running', containerStatuses: [{ name: 'app', restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });
    expect(podVerdict(crashing, now)).toMatchObject({ grade: 'failed', reason: 'CrashLoopBackOff', restarts: 7 });
  });
});

describe('replicaSetVerdict', () => {
  it('treats scaled-down revisions as healthy', () => {
    expect(replicaSetVerdict(obj('old', { spec: { replicas: 0 } }))).toEqual({ grade: 'healthy' });
    expect(replicaSetVerdict(obj('full', { spec: { replicas: 2 }, status: { availableReplicas: 2 } }))).toEqual({ grade: 'healthy' });
    expect(replicaSetVerdict(obj('half', { spec: { replicas: 2 }, status: { availableReplicas: 1 } }))).toEqual({ grade: 'degraded', reason: 'Unavailable', ready: 1, desired: 2 });
    expect(replicaSetVerdict(obj('none', { spec: { replicas: 2 } }))).toMatchObject({ grade: 'failed', ready: 0, desired: 2 });
  });
});

describe('gradeBuiltinKind', () => {
  it('reuses the workload checkers and lists one problem per unhealthy object', () => {
    const spec = HEALTH_KINDS.find((k) => k.kind === 'Deployment')!;
    const deployments = [
      obj('web', { spec: { replicas: 2 }, status: { availableReplicas: 2 } }),
      obj('api', { spec: { replicas: 2 }, status: { availableReplicas: 1 } }),
      obj('broken', { spec: { replicas: 1 } }),
    ];
    const { issues } = computeWorkloadHealth([{ spec, items: deployments, unavailable: false }]);
    const graded = gradeBuiltinKind(spec, deployments, issues, now)!;
    expect(graded.health).toEqual({ healthy: 1, degraded: 1, failed: 1 });
    expect(graded.problems).toEqual([
      { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'gap', name: 'api', grade: 'degraded', reason: 'Unavailable', message: undefined, ready: 1, desired: 2 },
      { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'gap', name: 'broken', grade: 'failed', reason: 'Unavailable', message: undefined, ready: 0, desired: 1 },
    ]);
  });

  it('keeps the problem count equal to the bar for pods, and leaves plain kinds without either', () => {
    const graded = gradeBuiltinKind(podSpec, [obj('a', { status: ready }), obj('b', { status: { phase: 'Failed', reason: 'Evicted' } }), obj('c', { status: { phase: 'Pending' } })], [], now)!;
    expect(graded.health).toEqual({ healthy: 1, degraded: 1, failed: 1 });
    expect(graded.problems.map((p) => [p.name, p.grade, p.reason])).toEqual([
      ['b', 'failed', 'Evicted'],
      ['c', 'degraded', 'Pending'],
    ]);
    expect(gradeBuiltinKind({ kind: 'ConfigMap', group: '', version: 'v1', plural: 'configmaps' }, [obj('cm')], [], now)).toBeUndefined();
  });
});

describe('gradeCustomKind', () => {
  it('grades Ready-condition operators and leaves unreconciled objects alone', () => {
    const certs = [
      obj('ok', { status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
      obj('issuing', { status: { conditions: [{ type: 'Ready', status: 'Unknown', reason: 'Issuing' }] } }),
      obj('broken', { status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Failed', message: 'issuer not found' }] } }),
      obj('new'),
    ];
    const graded = gradeCustomKind('certificates.cert-manager.io', certSpec, certs)!;
    expect(graded.health).toEqual({ healthy: 2, degraded: 1, failed: 1 });
    expect(graded.problems).toEqual([
      { ...certSpec, namespace: 'gap', name: 'broken', grade: 'failed', reason: 'Failed', message: 'issuer not found', custom: true },
      { ...certSpec, namespace: 'gap', name: 'issuing', grade: 'degraded', reason: 'Issuing', message: undefined, custom: true },
    ]);
  });

  it('grades Argo applications by health status', () => {
    const apps = [
      obj('synced', { status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } } }),
      obj('drift', { status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' } } }),
      obj('down', { status: { health: { status: 'Degraded' }, sync: { status: 'Synced' } } }),
    ];
    const spec = { kind: 'Application', group: 'argoproj.io', version: 'v1alpha1', plural: 'applications' };
    expect(gradeCustomKind('applications.argoproj.io', spec, apps)?.health).toEqual({ healthy: 1, degraded: 1, failed: 1 });
  });

  it('fails HTTPRoutes a parent rejected, with the parent condition as the reason', () => {
    const routes = [
      obj('attached', { status: { parents: [{ conditions: [{ type: 'Accepted', status: 'True' }, { type: 'ResolvedRefs', status: 'True' }] }] } }),
      rejectedRoute('orphan'),
      obj('no-controller'),
    ];
    const graded = gradeCustomKind('httproutes.gateway.networking.k8s.io', routeSpec, routes)!;
    expect(graded.health).toEqual({ healthy: 2, degraded: 0, failed: 1 });
    expect(graded.problems).toEqual([{ ...routeSpec, namespace: 'gap', name: 'orphan', grade: 'failed', reason: 'NoMatchingParent', message: 'Gateway missing-gw not found', custom: true }]);
  });

  it('has no bar for CRDs without a known status shape', () => {
    expect(gradeCustomKind('servicemonitors.monitoring.coreos.com', { kind: 'ServiceMonitor', group: 'monitoring.coreos.com', version: 'v1', plural: 'servicemonitors' }, [obj('sm')])).toBeUndefined();
  });
});

function fakeHandle(objects: Record<string, KubeObject[]>): ClusterHandle {
  const watcher = (plural: string) => ({ ready: async () => {}, items: () => objects[plural] ?? [], currentState: () => 'live' });
  return {
    watchers: {
      acquire: (_group: string, _version: string, plural: string) => ({ watcher: watcher(plural), release: () => {} }),
    },
    discovery: { getResources: async () => [] },
  } as unknown as ClusterHandle;
}

function crd(name: string, group: string, kind: string, plural: string): KubeObject {
  return {
    metadata: { name },
    spec: { group, scope: 'Namespaced', names: { kind, plural }, versions: [{ name: 'v1', served: true, storage: true }] },
  } as unknown as KubeObject;
}

const inNs = (o: KubeObject) => ({ ...o, metadata: { ...o.metadata, namespace: 'gap' } });
const namespaceObj = { metadata: { name: 'gap' }, status: { phase: 'Active' } } as unknown as KubeObject;

describe('computeNamespaceOverview inventory health', () => {
  it('attaches a health split to kinds that have one, custom resources included', async () => {
    const handle = fakeHandle({
      namespaces: [namespaceObj],
      customresourcedefinitions: [crd('certificates.cert-manager.io', 'cert-manager.io', 'Certificate', 'certificates')],
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

  it('explains every degraded or failed part of every bar in problems, failed first', async () => {
    const handle = fakeHandle({
      namespaces: [namespaceObj],
      customresourcedefinitions: [crd('httproutes.gateway.networking.k8s.io', 'gateway.networking.k8s.io', 'HTTPRoute', 'httproutes')],
      pods: [obj('ok', { status: ready }), obj('starting', { status: { phase: 'Pending' }, created: new Date().toISOString() })].map(inNs),
      httproutes: [rejectedRoute('orphan'), obj('fine')].map(inNs),
    });
    const overview = await computeNamespaceOverview(handle, ['gap']);
    const counted = overview.inventory.reduce((sum, e) => sum + (e.health ? e.health.degraded + e.health.failed : 0), 0);
    expect(overview.problems).toHaveLength(counted);
    expect(overview.problems.map((p) => [p.kind, p.name, p.grade, p.reason])).toEqual([
      ['HTTPRoute', 'orphan', 'failed', 'NoMatchingParent'],
      ['Pod', 'starting', 'degraded', 'Pending'],
    ]);
    expect(overview.problems[0]).toEqual({
      kind: 'HTTPRoute',
      group: 'gateway.networking.k8s.io',
      version: 'v1',
      plural: 'httproutes',
      namespace: 'gap',
      name: 'orphan',
      grade: 'failed',
      reason: 'NoMatchingParent',
      message: 'Gateway missing-gw not found',
      custom: true,
    });
    // The workload checkers have nothing to say about either.
    expect(overview.issues).toEqual([]);
    expect(overview.failingPods).toEqual([]);
  });
});

describe('Gateway API operator rollup', () => {
  it('reports rejected routes like any other not-ready operator resource', async () => {
    const handle = fakeHandle({ httproutes: [rejectedRoute('orphan'), obj('fine')].map(inNs) });
    const rollups = await computeOperatorRollups(handle, [crd('httproutes.gateway.networking.k8s.io', 'gateway.networking.k8s.io', 'HTTPRoute', 'httproutes')], new Set(['gap']));
    expect(rollups).toEqual([
      {
        id: 'gateway-api',
        name: 'Gateway API',
        resources: [
          expect.objectContaining({
            kind: 'HTTPRoute',
            total: 2,
            ready: 1,
            issues: [{ kind: 'HTTPRoute', namespace: 'gap', name: 'orphan', reason: 'NoMatchingParent', message: 'Gateway missing-gw not found' }],
          }),
        ],
      },
    ]);
  });
});
