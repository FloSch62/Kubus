import type { KubeObject } from '@kubus/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { collectMapSelectors, computeUsedBy, customCandidates, groupFamily, labelSelectorMatches, podSpecRelations, selectableLabels } from '../../../server/src/kube/used-by';

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
    // Every acquired watcher is released again, the CRD catalog included.
    const released = (handle as unknown as { released: string[] }).released;
    expect(released).toHaveLength(7);
    expect(released).toContain('apiextensions.k8s.io/v1/customresourcedefinitions');
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

  it('returns nothing for kinds without reverse links and only consults the CRD catalog', async () => {
    const handle = handleWith({});
    expect(await computeUsedBy(handle, { kind: 'Namespace', name: 'apps' })).toEqual({ items: [], unavailable: [], truncated: 0 });
    expect((handle as unknown as { released: string[] }).released).toEqual(['apiextensions.k8s.io/v1/customresourcedefinitions']);
    const acquire = vi.fn();
    const bare = { contextName: 'kind-a', discovery: { getResources: async () => [] }, watchers: { acquire } } as unknown as ClusterHandle;
    expect(await computeUsedBy(bare, { kind: 'Namespace', name: 'apps' }, { custom: false })).toEqual({ items: [], unavailable: [], truncated: 0 });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('answers Role and ClusterRole bindings with their subjects', async () => {
    const binding = (kind: string, name: string, namespace: string | undefined, roleRef: Record<string, string>, subjects: Array<Record<string, string>>) =>
      ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name, namespace, uid: name }, roleRef, subjects }) as KubeObject;
    const handle = handleWith({
      rolebindings: [
        binding('RoleBinding', 'readers', 'apps', { kind: 'Role', name: 'reader' }, [{ kind: 'ServiceAccount', name: 'app' }, { kind: 'User', name: 'jo' }]),
        binding('RoleBinding', 'elsewhere', 'other', { kind: 'Role', name: 'reader' }, []),
        binding('RoleBinding', 'admins', 'apps', { kind: 'ClusterRole', name: 'admin' }, [{ kind: 'Group', name: 'ops' }]),
      ],
      clusterrolebindings: [binding('ClusterRoleBinding', 'cluster-admins', undefined, { kind: 'ClusterRole', name: 'admin' }, [{ kind: 'Group', name: 'root' }])],
    });
    const role = await computeUsedBy(handle, { kind: 'Role', name: 'reader', namespace: 'apps' }, { custom: false });
    expect(role.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation} [${i.detail}]`)).toEqual(['RoleBinding/readers: grants [ServiceAccount app, User jo]']);
    const cluster = await computeUsedBy(handle, { kind: 'ClusterRole', name: 'admin' }, { custom: false });
    expect(cluster.items.map((i) => `${i.ref.kind}/${i.ref.name}`)).toEqual(['RoleBinding/admins', 'ClusterRoleBinding/cluster-admins']);
  });
});

/** OpenAPI object schema shorthand. */
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const string = { type: 'string' };
const list = (items: unknown) => ({ type: 'array', items });

function crd(group: string, kind: string, plural: string, spec: unknown, scope: 'Namespaced' | 'Cluster' = 'Namespaced'): KubeObject {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${group}`, uid: `crd-${plural}` },
    spec: {
      group,
      scope,
      names: { kind, plural },
      versions: [
        { name: 'v1alpha1', served: true, storage: false, schema: { openAPIV3Schema: object({ spec: object({ legacy: string }) }) } },
        { name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: object({ spec, status: object({ state: string }) }) } },
      ],
    },
  } as KubeObject;
}

const EDA = 'core.example.com';
const CRDS = [
  crd(EDA, 'TopoLink', 'topolinks', object({ links: list(object({ local: object({ node: string, interfaceResource: string }) })) })),
  crd(EDA, 'TopoNode', 'toponodes', object({ nodeProfile: string, mirrorNode: string, platform: string })),
  crd(EDA, 'NodeProfile', 'nodeprofiles', object({ yang: string })),
  crd(EDA, 'Fabric', 'fabrics', object({ leafs: object({ leafNodeSelectors: list(string) }) })),
  crd(EDA, 'Interface', 'interfaces', object({ members: list(object({ node: string, interface: string })) })),
  crd('services.example.com', 'VLAN', 'vlans', object({ bridgeDomain: string, vlanID: string })),
  crd('services.example.com', 'VirtualNetwork', 'virtualnetworks', object({ vlans: list(object({ name: string })) })),
  crd('other.example.com', 'Report', 'reports', object({ node: string, nodeCount: string }), 'Cluster'),
  crd('storage.vendor.io', 'Volume', 'volumes', object({ nodeID: string, secretName: string })),
  // A storage driver's own single-word Node kind must not claim every `node` field.
  crd('storage.vendor.io', 'Node', 'nodes', object({ disks: list(string) })),
];

function cr(kind: string, name: string, namespace: string | undefined, spec: Record<string, unknown>, labels?: Record<string, string>): KubeObject {
  return { metadata: { name, namespace, uid: `${kind}-${name}`, labels }, spec } as KubeObject;
}

/** A handle with warm caches for some plurals and paged LISTs (via raw.json) for the rest. */
function customHandle(live: Record<string, KubeObject[]>, listed: Record<string, KubeObject[]>, opts: { forbidden?: string[] } = {}) {
  const requests: string[] = [];
  const handle = {
    contextName: 'eda',
    discovery: { getResources: async () => [] },
    watchers: {
      acquire: (_g: string, _v: string, plural: string) => ({
        watcher: { ready: async () => undefined, items: () => (plural === 'customresourcedefinitions' ? CRDS : (live[plural] ?? [])), currentState: () => 'live' },
        release: () => undefined,
      }),
      peek: (_g: string, _v: string, plural: string) => (live[plural] ? { currentState: () => 'live', items: () => live[plural] } : undefined),
    },
    raw: {
      json: async (path: string) => {
        requests.push(path);
        const url = new URL(path, 'http://k8s');
        const plural = url.pathname.split('/').at(-1)!;
        if (opts.forbidden?.includes(plural)) throw Object.assign(new Error('forbidden'), { code: 403 });
        const limit = Number(url.searchParams.get('limit'));
        const start = Number(url.searchParams.get('continue') ?? 0);
        const all = listed[plural] ?? [];
        const items = all.slice(start, start + limit);
        return { items, metadata: { continue: start + limit < all.length ? String(start + limit) : '' } };
      },
    },
  } as unknown as ClusterHandle;
  return { handle, requests };
}

describe('customCandidates / collectMapSelectors', () => {
  it('ranks kinds by how their schema names the target kind, drops head-word matches from unrelated groups, keeps the whole own group', () => {
    const forNode = customCandidates(CRDS, { kind: 'TopoNode', name: 'l001', group: EDA, plural: 'toponodes' });
    // Own group with a `node` spec field, then the example.com family, then the rest of the group; the storage driver's nodeID is not about TopoNodes.
    expect(forNode.map((c) => c.kind)).toEqual(['Fabric', 'Interface', 'TopoLink', 'TopoNode', 'Report', 'NodeProfile']);
    // A status-only mention ranks behind spec mentions of the same family.
    const withStatus = [...CRDS, crd(EDA, 'Audit', 'audits', object({ note: string }))];
    const audit = withStatus.at(-1)!;
    (audit.spec as { versions: Array<{ schema: { openAPIV3Schema: unknown } }> }).versions[1]!.schema.openAPIV3Schema = object({ spec: object({ note: string }), status: object({ node: string }) });
    expect(customCandidates(withStatus, { kind: 'TopoNode', name: 'l001', group: EDA, plural: 'toponodes' }).map((c) => c.kind)).toEqual(['Fabric', 'Interface', 'TopoLink', 'TopoNode', 'Report', 'Audit', 'NodeProfile']);
    expect(customCandidates(CRDS, { kind: 'NodeProfile', name: 'p', group: EDA, plural: 'nodeprofiles' }).map((c) => c.kind)).toEqual(['TopoNode', 'Fabric', 'Interface', 'NodeProfile', 'TopoLink']);
    // A builtin Secret is spelled out by the storage driver's secretName.
    expect(customCandidates(CRDS, { kind: 'Secret', name: 's', group: '', plural: 'secrets' }).map((c) => c.kind)).toEqual(['Volume']);
    expect(groupFamily('interfaces.eda.nokia.com')).toBe('eda.nokia.com');
    expect(groupFamily('longhorn.io')).toBe('longhorn.io');
    expect(forNode.find((c) => c.kind === 'Report')).toMatchObject({ version: 'v1', namespaced: false });
    const forVn = customCandidates(CRDS, { kind: 'VirtualNetwork', name: 'vn-a', group: 'services.example.com', plural: 'virtualnetworks' });
    expect(forVn.map((c) => c.kind)).toEqual(['VirtualNetwork', 'VLAN']);
    // Kinds the builtin matchers already cover are not scanned twice.
    expect(customCandidates(CRDS, { kind: 'TopoNode', name: 'l001', group: EDA, plural: 'toponodes' }, [{ group: EDA, version: 'v1', plural: 'fabrics', kind: 'Fabric', namespaced: true }]).map((c) => c.kind)).not.toContain('Fabric');
  });

  it('finds map-shaped selectors and leaves lists and scalars alone', () => {
    expect(collectMapSelectors({ spec: { podSelector: { matchLabels: { app: 'web' } }, selector: { tier: 'db' }, nodeSelector: ['role=leaf'], deep: [{ endpointSelector: { matchLabels: {} } }] } })).toEqual([
      { path: 'spec.podSelector.matchLabels', selector: { app: 'web' } },
      { path: 'spec.selector', selector: { tier: 'db' } },
    ]);
  });
});

describe('computeUsedBy for custom kinds', () => {
  const target = { kind: 'TopoNode', name: 'l001', namespace: 'eda', group: EDA, plural: 'toponodes', uid: 'TopoNode-l001', labels: { role: 'leaf' } };

  it('lists name references, label selectors and inline selectors, paging kinds without a warm cache', async () => {
    const { handle, requests } = customHandle(
      { fabrics: [cr('Fabric', 'fab1', 'eda', { leafs: { leafNodeSelectors: ['role=leaf'] } }), cr('Fabric', 'spines', 'eda', { leafs: { leafNodeSelectors: ['role=spine'] } })] },
      {
        topolinks: [
          cr('TopoLink', 'l001-l002', 'eda', { links: [{ local: { node: 'l001', interfaceResource: 'l001-e1' } }] }),
          cr('TopoLink', 'l002-l003', 'eda', { links: [{ local: { node: 'l002' } }] }),
          cr('TopoLink', 'far', 'other', { links: [{ local: { node: 'l001' } }] }),
        ],
        toponodes: [
          cr('TopoNode', 'l001', 'eda', { mirrorNode: 'l001' }, { role: 'leaf' }),
          cr('TopoNode', 'l002', 'eda', { nodeProfile: 'l001' }),
          cr('TopoNode', 'l003', 'eda', { mirrorNode: 'l001' }),
        ],
        interfaces: [cr('Interface', 'l001-e1', 'eda', { members: [{ node: 'l001', interface: 'ethernet-1/1' }] })],
        nodeprofiles: [],
        reports: [cr('Report', 'daily', undefined, { node: 'l001', nodeCount: '5' })],
      },
    );
    const result = await computeUsedBy(handle, target, { pageSize: 2 });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.namespace ?? '-'}/${i.ref.name}: ${i.relation} [${i.detail}]`)).toEqual([
      'Fabric/eda/fab1: selects [spec.leafs.leafNodeSelectors]',
      'Interface/eda/l001-e1: references [spec.members.node]',
      'Report/-/daily: references [spec.node]',
      'TopoLink/eda/l001-l002: references [spec.links.local.node]',
      'TopoNode/eda/l003: references [spec.mirrorNode]',
    ]);
    expect(result.items[0]?.ref).toMatchObject({ ctx: 'eda', group: EDA, version: 'v1', plural: 'fabrics', namespace: 'eda' });
    expect(result.unavailable).toEqual([]);
    expect(result.partial).toBeUndefined();
    // Warm caches are not re-listed; cold namespaced kinds page through the target namespace only.
    expect(requests.filter((r) => r.includes('/fabrics'))).toEqual([]);
    expect(requests.filter((r) => r.includes('/topolinks'))).toEqual([
      '/apis/core.example.com/v1/namespaces/eda/topolinks?limit=2',
      '/apis/core.example.com/v1/namespaces/eda/topolinks?limit=2&continue=2',
    ]);
    expect(requests.filter((r) => r.includes('/reports'))).toEqual(['/apis/other.example.com/v1/reports?limit=2']);
  });

  it('labels and annotations keyed after the kind count as references', async () => {
    const { handle } = customHandle(
      {},
      {
        vlans: [
          cr('VLAN', 'vlan-10', 'svc', { bridgeDomain: 'bd-a' }, { 'services.example.com/virtualnetwork': 'vn-a' }),
          cr('VLAN', 'vlan-20', 'svc', { bridgeDomain: 'bd-b' }, { 'services.example.com/virtualnetwork': 'vn-b' }),
        ],
        virtualnetworks: [cr('VirtualNetwork', 'vn-a', 'svc', { vlans: [{ name: 'vlan-10' }] })],
      },
    );
    const result = await computeUsedBy(handle, { kind: 'VirtualNetwork', name: 'vn-a', namespace: 'svc', group: 'services.example.com', plural: 'virtualnetworks', uid: 'VirtualNetwork-vn-a' });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation} [${i.detail}]`)).toEqual(['VLAN/vlan-10: labeled [services.example.com/virtualnetwork]']);
  });

  it('reports kinds it could not read and kinds it stopped scanning early', async () => {
    const { handle, requests } = customHandle(
      {},
      {
        topolinks: Array.from({ length: 5 }, (_, i) => cr('TopoLink', `link-${i}`, 'eda', { links: [{ local: { node: 'l001' } }] })),
        toponodes: [],
        interfaces: [],
        nodeprofiles: [],
        reports: [],
      },
      { forbidden: ['interfaces'] },
    );
    const result = await computeUsedBy(handle, target, { pageSize: 2, scanLimit: 2 });
    expect(result.unavailable).toEqual(['Interface']);
    expect(result.partial).toEqual(['TopoLink']);
    expect(result.items).toHaveLength(2);
    expect(requests.filter((r) => r.includes('/topolinks'))).toHaveLength(1);
  });
});
