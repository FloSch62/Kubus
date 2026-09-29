import type { KubeObject } from '@kubus/shared';
import { describe, expect, it } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { computeReferences, kindsForHint } from '../../../server/src/kube/references';
import { holdsNonNameValues } from '../../../server/src/kube/relation-hints';

const object = (properties: Record<string, unknown>, description?: string) => ({ type: 'object', properties, ...(description ? { description } : {}) });
const string = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const list = (items: unknown, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });

function crd(group: string, kind: string, plural: string, spec: unknown, scope: 'Namespaced' | 'Cluster' = 'Namespaced', status: unknown = object({ state: string() })): KubeObject {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${group}`, uid: `crd-${plural}` },
    spec: { group, scope, names: { kind, plural }, versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: object({ spec, status }) } }] },
  } as KubeObject;
}

const EDA = 'core.example.com';
const endpoint = object({ node: string('Reference to a TopoNode.'), interfaceResource: string('Reference to an Interface object.') });
const CRDS = [
  crd(EDA, 'TopoLink', 'topolinks', object({ links: list(object({ local: endpoint, remote: endpoint })) }), 'Namespaced', object({ members: list(object({ node: string('Reference to a TopoNode') })) })),
  crd(EDA, 'TopoNode', 'toponodes', object({ nodeProfile: string(), platform: string() })),
  crd(EDA, 'TargetNode', 'targetnodes', object({ platform: string() })),
  crd(EDA, 'NodeProfile', 'nodeprofiles', object({ yang: string() })),
  crd('fabrics.example.com', 'Fabric', 'fabrics', object({ leafs: object({ leafNodeSelectors: list(string(), 'Label selector used to select Toponodes.') }), credentialSecret: string() })),
  crd('interfaces.example.com', 'Interface', 'interfaces', object({ members: list(object({ node: string() })) })),
  crd('services.example.com', 'VirtualNetwork', 'virtualnetworks', object({ vlans: list(object({ name: string() })) })),
  crd('bridges.example.com', 'BridgeDomain', 'bridgedomains', object({ type: string() })),
  crd('bridges.example.com', 'VlanPort', 'vlanports', object({ bridgeDomain: string('Reference to a BridgeDomain.'), vlan: string() })),
  crd('gateway.networking.k8s.io', 'HTTPRoute', 'httproutes', object({
    hostnames: list(string(), 'Hostnames defines a set of hostnames that should match against the HTTP Host header to select a HTTPRoute used to process the request.'),
    rules: list(object({ backendRefs: list(object({ name: string('Name is the name of the referent.'), port: { type: 'integer' } })) })),
  })),
];

interface Fixture {
  focus: KubeObject;
  custom: Record<string, Array<{ name: string; namespace?: string; uid: string; labels?: Record<string, string> }>>;
  builtin?: Record<string, KubeObject[]>;
  gettable?: Record<string, KubeObject>;
}

function handleWith(fixture: Fixture, opts: { indexLive?: boolean; pending?: string[] } = {}) {
  const gets: string[] = [];
  const lookups: string[] = [];
  const kindInfo = (plural: string) => {
    const spec = CRDS.find((c) => (c.spec as { names: { plural: string } }).names.plural === plural)!.spec as { group: string; scope: string; names: { kind: string; plural: string } };
    return { group: spec.group, version: 'v1', plural, kind: spec.names.kind, namespaced: spec.scope === 'Namespaced', verbs: ['list'], custom: true };
  };
  const entries = (plural: string) => (fixture.custom[plural] ?? []).map((e) => ({ kind: kindInfo(plural), ...e }));
  const handle = {
    contextName: 'eda',
    raw: {
      json: async (path: string) => {
        gets.push(path);
        if (path.endsWith(`/${fixture.focus.metadata.name}`) && path.includes(`/${(fixture.focus as { plural?: string }).plural ?? 'topolinks'}/`)) return fixture.focus;
        const hit = fixture.gettable?.[path];
        if (hit) return hit;
        throw Object.assign(new Error('not found'), { code: 404 });
      },
    },
    watchers: {
      acquire: (_g: string, _v: string, plural: string) => ({
        watcher: { ready: async () => undefined, items: () => (plural === 'customresourcedefinitions' ? CRDS : []), currentState: () => 'live' },
        release: () => undefined,
      }),
      peek: (_g: string, _v: string, plural: string) => (fixture.builtin?.[plural] ? { currentState: () => 'live', items: () => fixture.builtin![plural] } : undefined),
    },
    searchIndex: {
      warm: () => undefined,
      customKindsLive: () => !!opts.indexLive,
      isLive: (_group: string, plural: string) => !!opts.indexLive && plural in fixture.custom,
      entriesForKind: (_group: string, plural: string) => entries(plural),
      lookup: (_group: string, plural: string, namespace: string | undefined, name: string) => entries(plural).find((e) => e.name === name && (e.namespace ?? undefined) === namespace),
      liveEntries: () => Object.keys(fixture.custom).flatMap(entries),
    },
    referenceIndex: {
      setVocabulary: () => undefined,
      lookup: async (spec: { plural: string }) => {
        lookups.push(spec.plural);
        if (opts.pending?.includes(spec.plural)) return { entries: [], ready: false, unavailable: false };
        return { entries: entries(spec.plural).map((e) => ({ ...e, digest: { hints: [], selectors: [] } })), ready: true, unavailable: false };
      },
    },
  } as unknown as ClusterHandle;
  return { handle, gets, lookups };
}

function cr(kind: string, plural: string, name: string, namespace: string | undefined, spec: Record<string, unknown>, extra: Record<string, unknown> = {}): KubeObject & { plural: string } {
  return { apiVersion: `${EDA}/v1`, kind, plural, metadata: { name, namespace, uid: `${kind}-${name}` }, spec, ...extra } as KubeObject & { plural: string };
}

describe('kindsForHint', () => {
  const kinds = [
    { group: EDA, version: 'v1', plural: 'toponodes', kind: 'TopoNode', namespaced: true, custom: true },
    { group: EDA, version: 'v1', plural: 'targetnodes', kind: 'TargetNode', namespaced: true, custom: true },
    { group: EDA, version: 'v1', plural: 'nodeprofiles', kind: 'NodeProfile', namespaced: true, custom: true },
    { group: 'c9s.run', version: 'v1', plural: 'nodeprofiles', kind: 'NodeProfile', namespaced: true, custom: true },
    { group: '', version: 'v1', plural: 'nodes', kind: 'Node', namespaced: false, custom: false },
    { group: '', version: 'v1', plural: 'secrets', kind: 'Secret', namespaced: true, custom: false },
  ];
  const source = { group: EDA };

  it('lets the schema description, a sibling kind field, then field-name coverage decide, own group first', () => {
    const names = (result: { kinds: Array<{ kind: string; group: string }> }) => result.kinds.map((k) => k.kind);
    expect(kindsForHint({ path: 'spec.links[0].local.node', value: 'x' }, kinds, source, 'Reference to a TopoNode.')).toMatchObject({ certain: true });
    expect(names(kindsForHint({ path: 'spec.links[0].local.node', value: 'x' }, kinds, source, 'Reference to a TopoNode.'))).toEqual(['TopoNode']);
    expect(kindsForHint({ path: 'spec.peer.name', value: 'x', referenceKind: 'TargetNode' }, kinds, source)).toMatchObject({ certain: true });
    // An explicit group picks the same-named kind of that group, even outside the source's own.
    expect(kindsForHint({ path: 'spec.profile.name', value: 'x', referenceKind: 'NodeProfile', referenceGroup: 'c9s.run' }, kinds, source).kinds.map((k) => k.group)).toEqual(['c9s.run']);
    expect(names(kindsForHint({ path: 'spec.peer.name', value: 'x', referenceKind: 'TargetNode' }, kinds, source))).toEqual(['TargetNode']);
    // A description that merely mentions the kind is not a reference; the field name then decides, uncertainly.
    expect(kindsForHint({ path: 'spec.platform', value: 'x' }, kinds, source, 'Platform of the TopoNode.')).toEqual({ kinds: [], certain: false });
    expect(kindsForHint({ path: 'spec.members[0].node', value: 'x' }, kinds, source, 'Node name.')).toMatchObject({ certain: false });
    // Without a description, every same-group kind the head word covers ties; the core Node sits a tier lower.
    expect(names(kindsForHint({ path: 'spec.members[0].node', value: 'x' }, kinds, source))).toEqual(['TopoNode', 'TargetNode']);
    // nodeProfile covers NodeProfile twice and TopoNode once; the same-group NodeProfile beats the other operator's.
    expect(kindsForHint({ path: 'spec.nodeProfile', value: 'x' }, kinds, source).kinds.map((k) => `${k.group}/${k.kind}`)).toEqual([`${EDA}/NodeProfile`]);
    expect(names(kindsForHint({ path: 'spec.credentialSecret', value: 'x' }, kinds, source))).toEqual(['Secret']);
    expect(names(kindsForHint({ path: 'spec.secretRef.name', value: 'x' }, kinds, source))).toEqual(['Secret']);
    expect(kindsForHint({ path: 'spec.description', value: 'x' }, kinds, source)).toEqual({ kinds: [], certain: false });
    // The last segment decides: a secret field under `nodes[]` is a Secret, not a node.
    expect(names(kindsForHint({ path: 'spec.nodes[0].credentialSecret', value: 'x' }, kinds, source))).toEqual(['Secret']);
  });
});

describe('computeReferences', () => {
  it('resolves class, RBAC and ReplicaSet references using the correct group and scope', async () => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', {
      runtimeClassName: 'kata', ingressClassName: 'edge', replicaSetRef: { name: 'workers' },
      roleRef: { kind: 'Role', group: 'rbac.authorization.k8s.io', name: 'reader' },
      clusterRoleRef: { kind: 'ClusterRole', group: 'rbac.authorization.k8s.io', name: 'viewer' },
    });
    const targets = [
      ['node.k8s.io', 'runtimeclasses', 'RuntimeClass', 'kata', undefined],
      ['networking.k8s.io', 'ingressclasses', 'IngressClass', 'edge', undefined],
      ['apps', 'replicasets', 'ReplicaSet', 'workers', 'eda'],
      ['rbac.authorization.k8s.io', 'roles', 'Role', 'reader', 'eda'],
      ['rbac.authorization.k8s.io', 'clusterroles', 'ClusterRole', 'viewer', undefined],
    ] as const;
    const gettable = Object.fromEntries(targets.map(([group, plural, kind, name, namespace]) => [
      `/apis/${group}/v1/${namespace ? `namespaces/${namespace}/` : ''}${plural}/${name}`, cr(kind, plural, name, namespace, {}),
    ]));
    const { handle, gets } = handleWith({ focus, custom: {}, gettable });
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' });
    expect(result.items.map((item) => [item.ref.group, item.ref.plural, item.ref.kind, item.ref.name, item.ref.namespace])).toEqual(targets);
    expect(gets.slice(1)).toEqual(Object.keys(gettable));
  });

  it.each([true, false])('enforces structured selector expressions with matchLabels=%s', async (withLabels) => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', {
      target: { kind: 'TopoNode', group: EDA, namespace: 'other', selector: {
        ...(withLabels ? { matchLabels: { app: 'api' } } : {}),
        matchExpressions: [{ key: 'tier', operator: 'In', values: ['frontend'] }],
      } },
    });
    const { handle } = handleWith({ focus, custom: { toponodes: [
      { name: 'front', namespace: 'other', uid: 'front', labels: { app: 'api', tier: 'frontend' } },
      { name: 'back', namespace: 'other', uid: 'back', labels: { app: 'api', tier: 'backend' } },
      { name: 'wrong-ns', namespace: 'eda', uid: 'wrong-ns', labels: { app: 'api', tier: 'frontend' } },
    ] } }, { indexLive: true });
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' });
    expect(result.items.map((item) => item.ref.name)).toEqual(['front']);
    expect(result.items[0]?.relation).toBe('selects');
  });

  it('uses only names from typed references, not their namespace or API metadata', async () => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', {
      target: { apiVersion: 'apps/v1', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'team-a', name: 'api' },
    });
    const { handle, gets } = handleWith({ focus, custom: {}, gettable: {
      '/apis/apps/v1/namespaces/team-a/deployments/api': cr('Deployment', 'deployments', 'api', 'team-a', {}),
    } });
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' });
    expect(result.items.map((item) => item.ref.name)).toEqual(['api']);
    expect(gets).toHaveLength(2);
  });

  it.each(['app=x', { app: 'x' }])('preserves explicit kind, group and namespace for selector %j', async (selector) => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', {
      target: { kind: 'Service', group: '', namespace: 'other', selector },
      wrongGroup: { kind: 'Service', group: 'other.example', namespace: 'other', selector },
    });
    const service = (namespace: string) => ({ ...cr('Service', 'services', 'api', namespace, {}), metadata: { name: 'api', namespace, uid: namespace, labels: { app: 'x' } } });
    const { handle } = handleWith({ focus, custom: {}, builtin: { services: [service('eda'), service('other')] } });
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ ref: { kind: 'Service', group: '', namespace: 'other', name: 'api' }, relation: 'selects', detail: 'spec.target.selector' });
  });

  it('verifies references past the GET cap through one shared pool, or reports them as partial', async () => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', {
      targets: Array.from({ length: 43 }, (_, i) => ({ kind: 'TopoNode', name: `node-${i}` })),
    });
    const fixture = { focus, custom: { toponodes: [{ name: 'node-41', namespace: 'eda', uid: 'found' }] } };
    const source = { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' };
    const cold = handleWith(fixture);
    const result = await computeReferences(cold.handle, source);
    expect(cold.gets).toHaveLength(41); // source + 40 existence GETs
    expect(cold.lookups).toEqual(['toponodes']);
    expect(result.items.filter((item) => !item.missing).map((item) => item.ref.name)).toEqual(['node-41']);
    expect(result.items.filter((item) => item.missing)).toHaveLength(42);

    const pending = handleWith(fixture, { pending: ['toponodes'] });
    const early = await computeReferences(pending.handle, source);
    expect(early.partial).toEqual(['TopoNode']);
    expect(early.items).toHaveLength(40);
    expect(early.items.every((item) => item.missing)).toBe(true);
  });

  it.each([403, 500])('does not link targets when an existence GET fails with %i', async (code) => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', { target: { kind: 'TopoNode', name: 'unknown' } });
    const { handle } = handleWith({ focus, custom: {} });
    handle.raw.json = async (path: string) => {
      if (path.endsWith('/topolinks/link')) return focus as never;
      throw Object.assign(new Error('unavailable'), { code });
    };
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' });
    expect(result.items).toEqual([]);
    expect(result.unavailable).toEqual(['TopoNode']);
  });

  it('counts distinct omitted selector matches, excluding targets shown by another reference', async () => {
    const focus = cr('TopoLink', 'topolinks', 'link', 'eda', {
      target: { kind: 'TopoNode', selector: 'app=x' },
      repeated: { kind: 'TopoNode', selector: 'app=x' },
      named: { kind: 'TopoNode', name: 'node-104' },
    });
    const { handle } = handleWith({ focus, custom: { toponodes: Array.from({ length: 105 }, (_, i) => ({ name: `node-${String(i).padStart(3, '0')}`, namespace: 'eda', uid: String(i), labels: { app: 'x' } })) } }, { indexLive: true });
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'link', namespace: 'eda' });
    expect(result.items).toHaveLength(101);
    expect(result.truncated).toBe(4);
  });

  it('resolves names through the live index, flags dangling spec references, and follows labels and selectors', async () => {
    const focus = cr('TopoLink', 'topolinks', 'l001-s001', 'eda', { links: [{ local: { node: 'l001', interfaceResource: 'l001-e1', interface: 'ethernet-1-1' }, remote: { node: 'ghost', interfaceResource: 'ghost-e1' } }] }, {
      status: { members: [{ node: 'l001' }] },
    });
    focus.metadata.labels = { 'services.example.com/virtualnetwork': 'vn-a', app: 'demo' };
    const { handle, gets } = handleWith(
      {
        focus,
        custom: {
          toponodes: [{ name: 'l001', namespace: 'eda', uid: 'tn-1' }, { name: 's001', namespace: 'eda', uid: 'tn-2' }],
          targetnodes: [{ name: 'l001', namespace: 'eda', uid: 'tg-1' }],
          interfaces: [{ name: 'l001-e1', namespace: 'eda', uid: 'if-1' }],
          virtualnetworks: [{ name: 'vn-a', namespace: 'eda', uid: 'vn-1' }],
        },
      },
      { indexLive: true },
    );
    const result = await computeReferences(handle, { group: EDA, version: 'v1', plural: 'topolinks', kind: 'TopoLink', name: 'l001-s001', namespace: 'eda' });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation} [${i.detail}]${i.missing ? ' MISSING' : ''}`)).toEqual([
      'TopoNode/l001: references [spec.links.local.node, status.members.node]',
      'Interface/l001-e1: references [spec.links.local.interfaceResource]',
      'TopoNode/ghost: references [spec.links.remote.node] MISSING',
      'Interface/ghost-e1: references [spec.links.remote.interfaceResource] MISSING',
      'VirtualNetwork/vn-a: labeled [services.example.com/virtualnetwork]',
    ]);
    expect(result.items[0]?.ref).toMatchObject({ ctx: 'eda', group: EDA, plural: 'toponodes', namespace: 'eda', uid: 'tn-1' });
    // The description settled TopoNode over TargetNode, the port name `interface` was only a guess and
    // never confirmed (so no dangling row), and nothing needed a GET beyond the object itself.
    expect(result.items.map((i) => i.ref.kind)).not.toContain('TargetNode');
    expect(result.items.map((i) => i.ref.name)).not.toContain('ethernet-1-1');
    expect(gets).toHaveLength(1);
  });

  it('resolves selectors against indexed labels and builtin kinds against watcher caches or bounded GETs', async () => {
    const focus = cr('Fabric', 'fabrics', 'fab1', 'eda', { leafs: { leafNodeSelectors: ['role=leaf'] }, credentialSecret: 'creds', configMapRef: { name: 'settings' } });
    const secret = (name: string) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'eda', uid: `secret-${name}` } }) as KubeObject;
    const { handle, gets } = handleWith(
      {
        focus,
        custom: {
          toponodes: [
            { name: 'l001', namespace: 'eda', uid: 'tn-1', labels: { role: 'leaf' } },
            { name: 'l002', namespace: 'eda', uid: 'tn-2', labels: { role: 'leaf' } },
            { name: 's001', namespace: 'eda', uid: 'tn-3', labels: { role: 'spine' } },
            { name: 'x001', namespace: 'other', uid: 'tn-4', labels: { role: 'leaf' } },
          ],
        },
        builtin: { secrets: [secret('creds'), secret('other')] },
        gettable: { '/api/v1/namespaces/eda/configmaps/settings': { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'eda', uid: 'cm-1' } } as KubeObject },
      },
      { indexLive: true },
    );
    const result = await computeReferences(handle, { group: 'fabrics.example.com', version: 'v1', plural: 'fabrics', kind: 'Fabric', name: 'fab1', namespace: 'eda' });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation} [${i.detail}]`)).toEqual([
      'Secret/creds: references [spec.credentialSecret]',
      'ConfigMap/settings: references [spec.configMapRef.name]',
      'TopoNode/l001: selects [spec.leafs.leafNodeSelectors]',
      'TopoNode/l002: selects [spec.leafs.leafNodeSelectors]',
    ]);
    expect(gets).toEqual(['/apis/fabrics.example.com/v1/namespaces/eda/fabrics/fab1', '/api/v1/namespaces/eda/configmaps/settings']);
  });

  it('resolves selectors through the reference index when the search index is cold, and reports kinds still loading', async () => {
    const focus = cr('Fabric', 'fabrics', 'fab1', 'eda', { leafs: { leafNodeSelectors: ['role=leaf'] }, spines: { spineNodeSelectors: ['role=spine'] } });
    const fixture = {
      focus,
      custom: {
        toponodes: [
          { name: 'l001', namespace: 'eda', uid: 'tn-1', labels: { role: 'leaf' } },
          { name: 's001', namespace: 'eda', uid: 'tn-3', labels: { role: 'spine' } },
        ],
      },
    };
    const cold = handleWith(fixture);
    const result = await computeReferences(cold.handle, { group: 'fabrics.example.com', version: 'v1', plural: 'fabrics', kind: 'Fabric', name: 'fab1', namespace: 'eda' });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.relation}`)).toEqual(['TopoNode/l001: selects', 'TopoNode/s001: selects']);
    expect(result.partial).toBeUndefined();
    expect(cold.lookups).toContain('toponodes');

    const loading = handleWith(fixture, { pending: ['toponodes'] });
    const early = await computeReferences(loading.handle, { group: 'fabrics.example.com', version: 'v1', plural: 'fabrics', kind: 'Fabric', name: 'fab1', namespace: 'eda' });
    expect(early.items).toEqual([]);
    expect(early.partial).toEqual(['TopoNode']);
  });
});

describe('HTTPRoute hostnames', () => {
  const GATEWAY = 'gateway.networking.k8s.io';
  const HOSTNAMES_DESCRIPTION = 'Hostnames defines a set of hostnames that should match against the HTTP Host header to select a HTTPRoute used to process the request.';
  const kinds = [
    { group: GATEWAY, version: 'v1', plural: 'httproutes', kind: 'HTTPRoute', namespaced: true, custom: true },
    { group: '', version: 'v1', plural: 'services', kind: 'Service', namespaced: true, custom: false },
  ];

  it('ignores a description that only describes the object\'s own kind', () => {
    const route = { group: GATEWAY, kind: 'HTTPRoute' };
    expect(kindsForHint({ path: 'spec.hostnames[0]', value: 'podinfo.example.com' }, kinds, route, HOSTNAMES_DESCRIPTION)).toEqual({ kinds: [], certain: false });
    // The same prose on another kind's field still points at HTTPRoutes.
    expect(kindsForHint({ path: 'spec.targets[0]', value: 'podinfo' }, kinds, { group: 'policy.example.com', kind: 'RoutePolicy' }, HOSTNAMES_DESCRIPTION)).toMatchObject({ certain: true, kinds: [{ kind: 'HTTPRoute' }] });
  });

  it('needs the cue and the kind in the same sentence', () => {
    const route = { group: GATEWAY, kind: 'HTTPRoute' };
    const gatewayKinds = [...kinds, { group: GATEWAY, version: 'v1', plural: 'gateways', kind: 'Gateway', namespaced: true, custom: true }];
    const queryParam = 'Name is the name of the HTTP query param to be matched.\n\nIf a query param is repeated, it is recommended to match the first value, as this behavior is expected in other load balancing contexts outside of the Gateway API.';
    const sectionName = 'SectionName is the name of a section within the target resource. In the\nfollowing resources, SectionName is interpreted as the following:\n\n* Gateway: Listener name. When both Port and SectionName\nare specified, the name and port of the selected listener must match.';
    expect(kindsForHint({ path: 'spec.rules[0].matches[0].queryParams[0].name', value: 'canary' }, gatewayKinds, route, queryParam)).toMatchObject({ certain: false });
    expect(kindsForHint({ path: 'spec.parentRefs[0].sectionName', value: 'http' }, gatewayKinds, route, sectionName)).toMatchObject({ certain: false });
    expect(kindsForHint({ path: 'spec.parentRefs[0].name', value: 'web' }, gatewayKinds, route, 'Name of the Gateway this route attaches to.')).toMatchObject({ certain: true, kinds: [{ kind: 'Gateway' }] });
  });

  it('lets a sibling kind vouch for the reference name, not for its other fields', () => {
    const route = { group: GATEWAY, kind: 'HTTPRoute' };
    const gatewayKinds = [...kinds, { group: GATEWAY, version: 'v1', plural: 'gateways', kind: 'Gateway', namespaced: true, custom: true }];
    const parent = { referenceKind: 'Gateway', referenceGroup: GATEWAY };
    expect(kindsForHint({ path: 'spec.parentRefs[0].name', value: 'web', ...parent }, gatewayKinds, route)).toMatchObject({ certain: true, kinds: [{ kind: 'Gateway' }] });
    expect(kindsForHint({ path: 'spec.parentRefs[0].sectionName', value: 'http', ...parent }, gatewayKinds, route)).toEqual({ kinds: [], certain: false });
  });

  it('treats host, address, URL, path and image fields as holding no object names', () => {
    for (const path of ['spec.hostnames[0]', 'spec.hostname', 'status.addresses[0]', 'spec.address', 'spec.url', 'spec.ips[1]', 'spec.domains[1]', 'spec.image']) {
      expect(holdsNonNameValues(path), path).toBe(true);
    }
    // Only a field named exactly so: kind-named fields that end in one of the words stay references.
    for (const path of ['spec.rules[0].backendRefs[0].name', 'spec.secretName', 'spec.ipAddressPool', 'spec.nodeProfile', 'spec.hostPathClass', 'spec.bridgeDomain', 'spec.loadBalancerIP']) {
      expect(holdsNonNameValues(path), path).toBe(false);
    }
    // A field an installed kind is named after is left to the kind rules.
    expect(holdsNonNameValues('spec.domain', (field) => field === 'domain')).toBe(false);
  });

  it('does not list a hostname as a missing HTTPRoute', async () => {
    const focus = {
      ...cr('HTTPRoute', 'httproutes', 'podinfo', 'demo', { hostnames: ['podinfo.example.com'], rules: [{ backendRefs: [{ name: 'podinfo', port: 9898 }] }] }),
      apiVersion: `${GATEWAY}/v1`,
    };
    const { handle, gets } = handleWith({ focus, custom: {} });
    const result = await computeReferences(handle, { group: GATEWAY, version: 'v1', plural: 'httproutes', kind: 'HTTPRoute', name: 'podinfo', namespace: 'demo' });
    expect(result.items.map((item) => `${item.ref.kind}/${item.ref.name}`)).not.toContain('HTTPRoute/podinfo.example.com');
    expect(result.items.filter((item) => item.missing)).toEqual([]);
    expect(gets.some((path) => path.includes('podinfo.example.com'))).toBe(false);
  });
});

describe('review regressions', () => {
  it('keeps kind-named fields that end in a host-like word as references (bridgeDomain)', async () => {
    const focus = { ...cr('VlanPort', 'vlanports', 'bi-1', 'eda', { bridgeDomain: 'bd-a', vlan: 'vlan-10' }), apiVersion: 'bridges.example.com/v1' };
    const { handle } = handleWith({ focus, custom: { bridgedomains: [{ name: 'bd-a', namespace: 'eda', uid: 'bd' }] } }, { indexLive: true });
    const result = await computeReferences(handle, { group: 'bridges.example.com', version: 'v1', plural: 'vlanports', kind: 'VlanPort', name: 'bi-1', namespace: 'eda' });
    expect(result.items.map((i) => `${i.ref.kind}/${i.ref.name}: ${i.detail}`)).toEqual(['BridgeDomain/bd-a: spec.bridgeDomain']);
  });

  it('still lets a description point at the object\'s own kind with a plain reference cue', () => {
    const istio = 'networking.istio.io';
    const kinds = [{ group: istio, version: 'v1', plural: 'virtualservices', kind: 'VirtualService', namespaced: true, custom: true }];
    const source = { group: istio, kind: 'VirtualService' };
    expect(kindsForHint({ path: 'spec.http[0].delegate.name', value: 'reviews' }, kinds, source, 'Name specifies the name of the delegate VirtualService.')).toMatchObject({ certain: true, kinds: [{ kind: 'VirtualService' }] });
    expect(kindsForHint({ path: 'spec.hosts[0]', value: 'reviews' }, kinds, source, 'The destination hosts to which traffic is being sent, used to select a VirtualService.')).toMatchObject({ certain: false });
  });
});
