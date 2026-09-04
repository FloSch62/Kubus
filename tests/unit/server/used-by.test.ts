import type { KubeObject } from '@kubus/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { computeUsedBy, labelSelectorMatches, podSpecRelations, selectableLabels } from '../../../server/src/kube/used-by';

function obj(kind: string, name: string, namespace: string | undefined, spec: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): KubeObject {
  return { apiVersion: 'v1', kind, metadata: { name, namespace, uid: `${kind}-${name}` }, spec, ...extra } as KubeObject;
}

function podSpec(overrides: Record<string, unknown> = {}) {
  return {
    serviceAccountName: 'app-sa',
    containers: [
      {
        name: 'app',
        env: [{ name: 'MODE', valueFrom: { configMapKeyRef: { name: 'app-config', key: 'mode' } } }, { name: 'PW', valueFrom: { secretKeyRef: { name: 'db', key: 'pw' } } }],
        envFrom: [{ configMapRef: { name: 'shared' } }, { secretRef: { name: 'db' } }],
      },
    ],
    volumes: [
      { name: 'cfg', configMap: { name: 'app-config' } },
      { name: 'creds', secret: { secretName: 'db' } },
      { name: 'data', persistentVolumeClaim: { claimName: 'data-0' } },
      { name: 'token', projected: { sources: [{ configMap: { name: 'kube-root-ca.crt' } }, { secret: { name: 'db' } }] } },
    ],
    imagePullSecrets: [{ name: 'regcred' }],
    nodeName: 'worker-1',
    priorityClassName: 'high',
    ...overrides,
  };
}

/** A cluster handle whose watchers hand back canned lists per plural. */
function handleWith(lists: Record<string, KubeObject[]>, opts: { unavailable?: string[]; resources?: Array<Record<string, unknown>> } = {}): ClusterHandle {
  const released: string[] = [];
  return {
    contextName: 'kind-a',
    discovery: { getResources: async () => opts.resources ?? [] },
    watchers: {
      acquire: (group: string, version: string, plural: string) => ({
        watcher: {
          ready: async () => {
            if (opts.unavailable?.includes(plural)) throw Object.assign(new Error('forbidden'), { code: 403 });
          },
          items: () => lists[plural] ?? [],
          currentState: () => 'live',
        },
        release: () => released.push(`${group}/${version}/${plural}`),
      }),
    },
    released,
  } as unknown as ClusterHandle;
}

describe('podSpecRelations', () => {
  it('finds every way a pod spec uses a ConfigMap', () => {
    const relations = podSpecRelations(podSpec(), { kind: 'ConfigMap', name: 'app-config', namespace: 'apps' });
    expect(relations).toEqual([
      { relation: 'mounts', detail: 'volume cfg' },
      { relation: 'env', detail: 'app: MODE' },
    ]);
    expect(podSpecRelations(podSpec(), { kind: 'ConfigMap', name: 'kube-root-ca.crt', namespace: 'apps' })).toEqual([{ relation: 'mounts', detail: 'projected volume token' }]);
    expect(podSpecRelations(podSpec(), { kind: 'ConfigMap', name: 'shared', namespace: 'apps' })).toEqual([{ relation: 'env', detail: 'app: all keys' }]);
  });

  it('finds Secret volumes, env, envFrom, projected sources and image pull secrets', () => {
    expect(podSpecRelations(podSpec(), { kind: 'Secret', name: 'db', namespace: 'apps' }).map((r) => r.detail ?? r.relation)).toEqual([
      'volume creds',
      'projected volume token',
      'app: PW',
      'app: all keys',
    ]);
    expect(podSpecRelations(podSpec(), { kind: 'Secret', name: 'regcred', namespace: 'apps' })).toEqual([{ relation: 'image pull secret' }]);
  });

  it('resolves identity, storage, placement and class references', () => {
    const spec = podSpec();
    expect(podSpecRelations(spec, { kind: 'ServiceAccount', name: 'app-sa', namespace: 'apps' })).toEqual([{ relation: 'runs as' }]);
    expect(podSpecRelations(podSpec({ serviceAccountName: undefined }), { kind: 'ServiceAccount', name: 'default', namespace: 'apps' })).toEqual([{ relation: 'runs as', detail: 'implicit default' }]);
    expect(podSpecRelations(spec, { kind: 'PersistentVolumeClaim', name: 'data-0', namespace: 'apps' })).toEqual([{ relation: 'mounts', detail: 'volume data' }]);
    expect(podSpecRelations(spec, { kind: 'Node', name: 'worker-1' })).toEqual([{ relation: 'scheduled on' }]);
    expect(podSpecRelations(spec, { kind: 'PriorityClass', name: 'high' })).toEqual([{ relation: 'priority' }]);
    expect(podSpecRelations(spec, { kind: 'Node', name: 'worker-2' })).toEqual([]);
    expect(podSpecRelations(undefined, { kind: 'Node', name: 'worker-1' })).toEqual([]);
  });
});

describe('labelSelectorMatches / selectableLabels', () => {
  it('applies matchLabels and every expression operator', () => {
    const labels = { app: 'web', tier: 'front' };
    expect(labelSelectorMatches({ matchLabels: { app: 'web' } }, labels)).toBe(true);
    expect(labelSelectorMatches({ matchLabels: { app: 'api' } }, labels)).toBe(false);
    expect(labelSelectorMatches({ matchExpressions: [{ key: 'tier', operator: 'In', values: ['front', 'edge'] }] }, labels)).toBe(true);
    expect(labelSelectorMatches({ matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['front'] }] }, labels)).toBe(false);
    expect(labelSelectorMatches({ matchExpressions: [{ key: 'zone', operator: 'DoesNotExist' }] }, labels)).toBe(true);
    expect(labelSelectorMatches({ matchExpressions: [{ key: 'zone', operator: 'Exists' }] }, labels)).toBe(false);
    expect(labelSelectorMatches({ matchExpressions: [{ key: 'zone', operator: 'Weird' }] }, labels)).toBe(false);
    expect(labelSelectorMatches(undefined, labels)).toBe(false);
  });

  it('reads template labels off workloads and CronJobs', () => {
    expect(selectableLabels('Pod', obj('Pod', 'p', 'apps', {}, { metadata: { name: 'p', uid: 'p', labels: { app: 'x' } } }))).toEqual({ app: 'x' });
    expect(selectableLabels('Deployment', obj('Deployment', 'd', 'apps', { template: { metadata: { labels: { app: 'd' } } } }))).toEqual({ app: 'd' });
    expect(selectableLabels('CronJob', obj('CronJob', 'c', 'apps', { jobTemplate: { spec: { template: { metadata: { labels: { app: 'c' } } } } } }))).toEqual({ app: 'c' });
  });
});

describe('computeUsedBy', () => {
  it('lists workloads before standalone pods, dedupes relations per object and skips other namespaces', async () => {
    const handle = handleWith({
      pods: [obj('Pod', 'web-1', 'apps', podSpec()), obj('Pod', 'other', 'elsewhere', podSpec())],
      deployments: [obj('Deployment', 'web', 'apps', { template: { spec: podSpec() } })],
      cronjobs: [obj('CronJob', 'nightly', 'apps', { jobTemplate: { spec: { template: { spec: podSpec() } } } })],
      statefulsets: [],
      daemonsets: [],
      jobs: [],
    });
    const result = await computeUsedBy(handle, { kind: 'ConfigMap', name: 'app-config', namespace: 'apps' });
    expect(result.unavailable).toEqual([]);
    expect(result.truncated).toBe(0);
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation} [${i.detail}]`)).toEqual([
      'Deployment/web: mounts · env [volume cfg, app: MODE]',
      'CronJob/nightly: mounts · env [volume cfg, app: MODE]',
      'Pod/web-1: mounts · env [volume cfg, app: MODE]',
    ]);
    expect(result.items[0]?.ref).toMatchObject({ ctx: 'kind-a', group: 'apps', version: 'v1', plural: 'deployments', namespace: 'apps' });
    // Every acquired watcher is released again.
    expect((handle as unknown as { released: string[] }).released).toHaveLength(6);
  });

  it('reports referencing kinds that cannot be read instead of failing', async () => {
    const handle = handleWith({ pods: [obj('Pod', 'p', 'apps', podSpec())] }, { unavailable: ['deployments', 'cronjobs'] });
    const result = await computeUsedBy(handle, { kind: 'Secret', name: 'db', namespace: 'apps' });
    expect(result.unavailable).toEqual(['Deployment', 'CronJob']);
    expect(result.items.map((i) => i.ref.name)).toEqual(['p']);
  });

  it('resolves Ingress backends and Gateway API routes for a Service, honouring backend namespaces', async () => {
    const handle = handleWith(
      {
        ingresses: [
          obj('Ingress', 'public', 'apps', {
            defaultBackend: { service: { name: 'web' } },
            rules: [{ host: 'app.example.com', http: { paths: [{ path: '/api', backend: { service: { name: 'web' } } }] } }],
          }),
        ],
        httproutes: [
          obj('HTTPRoute', 'route', 'gateways', { hostnames: ['app.example.com'], rules: [{ matches: [{ path: { value: '/' } }], backendRefs: [{ name: 'web', namespace: 'apps' }] }] }),
          obj('HTTPRoute', 'wrong-ns', 'gateways', { rules: [{ backendRefs: [{ name: 'web' }] }] }),
        ],
      },
      { resources: [{ group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute', plural: 'httproutes', namespaced: true, verbs: ['list'] }] },
    );
    const result = await computeUsedBy(handle, { kind: 'Service', name: 'web', namespace: 'apps' });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.detail}`)).toEqual([
      'Ingress/public: default backend, app.example.com/api',
      'HTTPRoute/route: app.example.com /',
    ]);
    expect(result.items[1]?.ref).toMatchObject({ group: 'gateway.networking.k8s.io', version: 'v1', plural: 'httproutes', namespace: 'gateways' });
  });

  it('matches selectors for pods: Services, budgets and policies (an empty policy selector means every pod)', async () => {
    const handle = handleWith({
      services: [obj('Service', 'web', 'apps', { selector: { app: 'web' } }), obj('Service', 'none', 'apps', { selector: {} })],
      poddisruptionbudgets: [obj('PodDisruptionBudget', 'web-pdb', 'apps', { selector: { matchLabels: { app: 'web' } }, minAvailable: 1 })],
      networkpolicies: [obj('NetworkPolicy', 'deny-all', 'apps', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }), obj('NetworkPolicy', 'api-only', 'apps', { podSelector: { matchLabels: { app: 'api' } } })],
    });
    const result = await computeUsedBy(handle, { kind: 'Pod', name: 'web-1', namespace: 'apps', labels: { app: 'web' } });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation}${i.detail ? ` [${i.detail}]` : ''}`)).toEqual([
      'Service/web: exposes',
      'PodDisruptionBudget/web-pdb: protects [min available 1]',
      'NetworkPolicy/deny-all: applies to [Ingress + Egress · all pods in namespace]',
    ]);
  });

  it('answers ServiceAccount bindings, StorageClass claims and bound volumes', async () => {
    const sa = await computeUsedBy(
      handleWith({
        rolebindings: [obj('RoleBinding', 'rb', 'apps', {}, { subjects: [{ kind: 'ServiceAccount', name: 'app-sa' }], roleRef: { kind: 'Role', name: 'reader' } })],
        clusterrolebindings: [obj('ClusterRoleBinding', 'crb', undefined, {}, { subjects: [{ kind: 'ServiceAccount', name: 'app-sa', namespace: 'apps' }], roleRef: { kind: 'ClusterRole', name: 'view' } })],
      }),
      { kind: 'ServiceAccount', name: 'app-sa', namespace: 'apps' },
    );
    expect(sa.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.detail}`)).toEqual(['RoleBinding/rb: Role/reader', 'ClusterRoleBinding/crb: ClusterRole/view']);

    const sc = await computeUsedBy(
      handleWith({
        persistentvolumeclaims: [obj('PersistentVolumeClaim', 'data', 'apps', { storageClassName: 'fast', volumeName: 'pv-1' })],
        persistentvolumes: [obj('PersistentVolume', 'pv-1', undefined, { storageClassName: 'fast' })],
      }),
      { kind: 'StorageClass', name: 'fast' },
    );
    expect(sc.items.map((i) => `${i.ref.kind}/${i.ref.name}`)).toEqual(['PersistentVolumeClaim/data', 'PersistentVolume/pv-1']);
    const pv = await computeUsedBy(handleWith({ persistentvolumeclaims: [obj('PersistentVolumeClaim', 'data', 'apps', { volumeName: 'pv-1' })] }), { kind: 'PersistentVolume', name: 'pv-1' });
    expect(pv.items.map((i) => i.relation)).toEqual(['bound to']);
  });

  it('caps very long lists and keeps the controllers', async () => {
    const pods = Array.from({ length: 250 }, (_, i) => obj('Pod', `p-${String(i).padStart(3, '0')}`, 'apps', podSpec()));
    const handle = handleWith({ pods, deployments: [obj('Deployment', 'web', 'apps', { template: { spec: podSpec() } })] });
    const result = await computeUsedBy(handle, { kind: 'ConfigMap', name: 'app-config', namespace: 'apps' });
    expect(result.items).toHaveLength(200);
    expect(result.items[0]?.ref.kind).toBe('Deployment');
    expect(result.truncated).toBe(51);
  });

  it('returns nothing for kinds without reverse links', async () => {
    const acquire = vi.fn();
    const handle = { contextName: 'kind-a', discovery: { getResources: async () => [] }, watchers: { acquire } } as unknown as ClusterHandle;
    expect(await computeUsedBy(handle, { kind: 'Namespace', name: 'apps' })).toEqual({ items: [], unavailable: [], truncated: 0 });
    expect(acquire).not.toHaveBeenCalled();
  });
});
