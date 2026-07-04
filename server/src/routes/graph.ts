import type { FastifyInstance } from 'fastify';
import type { GraphEdge, GraphNode, GraphNodeStatus, KubeObject, RelationshipGraph, ResourceKindInfo, ResourceRef } from '@kubus/shared';
import type { AppContext } from '../app.js';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { sendError } from '../util/errors.js';

interface KindSpec {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
  layer: GraphNode['layer'];
}

const KINDS: KindSpec[] = [
  { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', kind: 'Ingress', namespaced: true, layer: 'entry' },
  { group: '', version: 'v1', plural: 'services', kind: 'Service', namespaced: true, layer: 'service' },
  { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, layer: 'workload' },
  { group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet', namespaced: true, layer: 'workload' },
  { group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet', namespaced: true, layer: 'workload' },
  { group: 'batch', version: 'v1', plural: 'cronjobs', kind: 'CronJob', namespaced: true, layer: 'workload' },
  { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job', namespaced: true, layer: 'workload' },
  { group: 'apps', version: 'v1', plural: 'replicasets', kind: 'ReplicaSet', namespaced: true, layer: 'replicaset' },
  { group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true, layer: 'pod' },
  { group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap', namespaced: true, layer: 'storage' },
  { group: '', version: 'v1', plural: 'secrets', kind: 'Secret', namespaced: true, layer: 'storage' },
  { group: '', version: 'v1', plural: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim', namespaced: true, layer: 'storage' },
  { group: '', version: 'v1', plural: 'persistentvolumes', kind: 'PersistentVolume', namespaced: false, layer: 'storage' },
  { group: '', version: 'v1', plural: 'nodes', kind: 'Node', namespaced: false, layer: 'node' },
];

interface Item {
  spec: KindSpec;
  obj: KubeObject;
}

interface RelationHint {
  path: string;
  value: string;
  selector?: Record<string, string>;
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
}

interface FocusQuery {
  namespace?: string;
  focusGroup?: string;
  focusVersion?: string;
  focusPlural?: string;
  focusKind?: string;
  focusNamespace?: string;
  focusName?: string;
  depth?: string;
}

function ref(ctx: string, spec: KindSpec, obj: KubeObject): ResourceRef {
  return {
    ctx,
    group: spec.group,
    version: spec.version,
    plural: spec.plural,
    kind: spec.kind,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    uid: obj.metadata.uid,
  };
}

function nodeId(ctx: string, spec: KindSpec, obj: KubeObject): string {
  return `${ctx}|${spec.group}|${spec.version}|${spec.plural}|${obj.metadata.namespace ?? ''}|${obj.metadata.name}`;
}

const POD_WAITING_ERROR_REASONS = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError']);
const STATE_SUCCESS_TERMS = new Set(['up', 'ready', 'running', 'active', 'available', 'succeeded', 'synced']);
const STATE_ERROR_TERMS = new Set(['down', 'failed', 'error', 'degraded', 'lost']);
const STATE_WARNING_TERMS = new Set(['pending', 'progressing', 'reconciling']);

function statusFor(kind: string, obj: KubeObject): { status: GraphNodeStatus; reason?: string } {
  const st = obj.status ?? {};
  const sp = obj.spec ?? {};
  if (kind === 'Pod') {
    const phase = st.phase as string | undefined;
    const statuses = (st.containerStatuses ?? []) as Array<{ restartCount?: number; state?: { waiting?: { reason?: string; message?: string } } }>;
    const waiting = statuses.find((c) => c.state?.waiting?.reason)?.state?.waiting;
    if (phase === 'Failed') return { status: 'error', reason: (st.reason as string | undefined) ?? 'Failed' };
    if (waiting?.reason && POD_WAITING_ERROR_REASONS.has(waiting.reason)) {
      return { status: 'error', reason: waiting.reason };
    }
    if (phase === 'Pending') return { status: 'warning', reason: waiting?.reason ?? 'Pending' };
    if (phase === 'Running') return { status: 'success' };
    return { status: 'unknown', reason: phase };
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'ReplicaSet') {
    const desired = (sp.replicas as number | undefined) ?? 1;
    const ready = (st.readyReplicas as number | undefined) ?? (st.availableReplicas as number | undefined) ?? 0;
    return ready >= desired ? { status: 'success' } : { status: desired > 0 ? 'warning' : 'unknown', reason: `${ready}/${desired} ready` };
  }
  if (kind === 'DaemonSet') {
    const desired = (st.desiredNumberScheduled as number | undefined) ?? 0;
    const ready = (st.numberReady as number | undefined) ?? 0;
    return ready >= desired ? { status: 'success' } : { status: 'warning', reason: `${ready}/${desired} ready` };
  }
  if (kind === 'Job') {
    if ((st.failed as number | undefined) && !st.active) return { status: 'error', reason: `${st.failed} failed` };
    if ((st.succeeded as number | undefined) && !st.active) return { status: 'success' };
    return { status: 'unknown' };
  }
  if (kind === 'PersistentVolume' || kind === 'PersistentVolumeClaim') {
    const phase = st.phase as string | undefined;
    if (phase === 'Bound') return { status: 'success' };
    if (phase === 'Failed' || phase === 'Lost') return { status: 'error', reason: phase };
    if (phase) return { status: 'warning', reason: phase };
  }
  const ready = ((st.conditions ?? []) as Array<{ type?: string; status?: string; reason?: string; message?: string }>).find((c) => c.type === 'Ready');
  if (kind === 'Node') {
    if (ready?.status === 'True') return { status: 'success' };
    if (ready?.status === 'False') return { status: 'error', reason: ready.reason ?? 'NotReady' };
    return { status: 'unknown' };
  }
  const operationalState = ((st.operationalState as string | undefined) ?? (st.state as string | undefined) ?? (st.phase as string | undefined))?.toLowerCase();
  if (operationalState && STATE_SUCCESS_TERMS.has(operationalState)) return { status: 'success' };
  if (operationalState && STATE_ERROR_TERMS.has(operationalState)) return { status: 'error', reason: operationalState };
  if (operationalState && STATE_WARNING_TERMS.has(operationalState)) return { status: 'warning', reason: operationalState };
  if (ready?.status === 'True') return { status: 'success' };
  if (ready?.status === 'False') return { status: 'warning', reason: ready.reason ?? ready.message ?? 'NotReady' };
  return { status: 'unknown' };
}

function sublabel(kind: string, obj: KubeObject): string | undefined {
  if (kind === 'Pod') return obj.metadata.namespace;
  if (kind === 'Service') return `${obj.metadata.namespace ?? ''} · ${(obj.spec?.type as string | undefined) ?? 'ClusterIP'}`;
  if (kind === 'Ingress') return obj.metadata.namespace;
  if (kind === 'Node') return (obj.status?.nodeInfo as { kubeletVersion?: string } | undefined)?.kubeletVersion;
  if (obj.metadata.namespace) return obj.metadata.namespace;
  return undefined;
}

function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  const entries = Object.entries(selector ?? {});
  return entries.length > 0 && entries.every(([k, v]) => labels?.[k] === v);
}

const IGNORED_RELATION_TERMS = new Set([
  'api',
  'change',
  'enabled',
  'generation',
  'health',
  'kind',
  'last',
  'metadata',
  'mode',
  'name',
  'namespace',
  'operating',
  'operational',
  'protocol',
  'reason',
  'resource',
  'score',
  'spec',
  'state',
  'status',
  'system',
  'time',
  'type',
  'version',
]);

const CAMEL_BOUNDARY_RE = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY_RE = /([A-Z]+)([A-Z][a-z])/g;
const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/;

function tokens(input: string): string[] {
  const spaced = input
    .replace(CAMEL_BOUNDARY_RE, '$1 $2')
    .replace(ACRONYM_BOUNDARY_RE, '$1 $2');
  return spaced
    .toLowerCase()
    .split(NON_ALPHANUMERIC_RE)
    .filter(Boolean)
    .map((token) => (token.endsWith('ies') ? `${token.slice(0, -3)}y` : token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token))
    .filter((token) => !IGNORED_RELATION_TERMS.has(token));
}

function parseEqualitySelector(value: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.includes('!=')) return undefined;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key || !val) return undefined;
    out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

const URL_VALUE_RE = /^https?:\/\//i;

function collectRelationHints(value: unknown, prefix = ''): RelationHint[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 120 || URL_VALUE_RE.test(trimmed)) return [];
    return [{ path: prefix, value: trimmed, selector: parseEqualitySelector(trimmed) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectRelationHints(item, `${prefix}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => collectRelationHints(item, prefix ? `${prefix}.${key}` : key));
  }
  return [];
}

const ARRAY_INDEX_RE = /\[\d+\]/g;

function hintLabel(path: string): string {
  const parts = path.replace(ARRAY_INDEX_RE, '').split('.').filter(Boolean);
  return parts.slice(-2).join('.') || 'ref';
}

async function listKind(handle: ClusterHandle, spec: KindSpec, namespaces: Set<string> | undefined, warnings: string[]): Promise<Item[]> {
  try {
    const query = new URLSearchParams({ limit: '2000' });
    const namespace = spec.namespaced && namespaces?.size === 1 ? [...namespaces][0] : undefined;
    const list = await handle.raw.json<{ items?: KubeObject[] }>(resourcePath(spec.group, spec.version, spec.plural, { namespace, query }));
    const items = (list.items ?? []).filter((obj) => !spec.namespaced || !namespaces?.size || namespaces.has(obj.metadata.namespace ?? ''));
    return items.map((obj) => ({ spec, obj }));
  } catch (err) {
    warnings.push(`${spec.kind}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function sameGvr(a: KindSpec, b: KindSpec): boolean {
  return a.group === b.group && a.version === b.version && a.plural === b.plural;
}

const K8S_VERSION_RE = /^v(\d+)(?:(alpha|beta)(\d+))?$/;

function versionScore(version: string): [number, number, number] {
  const match = K8S_VERSION_RE.exec(version);
  if (!match) return [0, 0, 0];
  const stability = match[2] === 'alpha' ? 1 : match[2] === 'beta' ? 2 : 3;
  return [stability, Number(match[1]), Number(match[3] ?? 0)];
}

function preferResourceVersion(candidate: ResourceKindInfo, current: ResourceKindInfo): ResourceKindInfo {
  const a = versionScore(candidate.version);
  const b = versionScore(current.version);
  if (a[0] !== b[0]) return a[0] > b[0] ? candidate : current;
  if (a[1] !== b[1]) return a[1] > b[1] ? candidate : current;
  if (a[2] !== b[2]) return a[2] > b[2] ? candidate : current;
  return candidate.version.localeCompare(current.version) > 0 ? candidate : current;
}

function dedupeResourceKinds(kinds: ResourceKindInfo[]): ResourceKindInfo[] {
  const byKind = new Map<string, ResourceKindInfo>();
  for (const kind of kinds) {
    const key = `${kind.group}/${kind.plural}/${kind.kind}`;
    const current = byKind.get(key);
    byKind.set(key, current ? preferResourceVersion(kind, current) : kind);
  }
  return [...byKind.values()];
}

function focusKindSpec(query: FocusQuery): KindSpec | undefined {
  if (query.focusGroup === undefined || !query.focusVersion || !query.focusPlural || !query.focusKind || !query.focusName) return undefined;
  return {
    group: query.focusGroup,
    version: query.focusVersion,
    plural: query.focusPlural,
    kind: query.focusKind,
    namespaced: !!query.focusNamespace,
    layer: layerForDynamicKind(query.focusKind),
  };
}

async function getFocusedItem(handle: ClusterHandle, spec: KindSpec, query: FocusQuery, warnings: string[]): Promise<Item[]> {
  if (!query.focusName) return [];
  try {
    const obj = await handle.raw.json<KubeObject>(
      resourcePath(spec.group, spec.version, spec.plural, {
        namespace: spec.namespaced ? query.focusNamespace : undefined,
        name: query.focusName,
      }),
    );
    return [{ spec, obj }];
  } catch (err) {
    warnings.push(`${spec.kind}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function resourceKindToSpec(kind: ResourceKindInfo): KindSpec {
  return {
    group: kind.group,
    version: kind.version,
    plural: kind.plural,
    kind: kind.kind,
    namespaced: kind.namespaced,
    layer: layerForDynamicKind(kind.kind),
  };
}

function layerForDynamicKind(kind: string): GraphNode['layer'] {
  const k = kind.toLowerCase();
  if (k.includes('node')) return 'node';
  if (k.includes('pool') || k.includes('secret') || k.includes('config')) return 'storage';
  if (k.includes('link') || k.includes('interface') || k.includes('route') || k.includes('router') || k.includes('fabric') || k.includes('topology')) return 'route';
  if (k.includes('deployment') || k.includes('workload')) return 'workload';
  if (k.endsWith('state') || k.includes('monitor')) return 'operator';
  return 'other';
}

function scoreCandidateKind(kind: ResourceKindInfo, focusSpec: KindSpec, hintTerms: Set<string>): number {
  if (!kind.verbs.includes('list') || sameGvr(resourceKindToSpec(kind), focusSpec)) return 0;
  const kindTerms = tokens(`${kind.kind} ${kind.plural}`);
  let score = kind.group === focusSpec.group ? 1 : 0;
  for (const term of kindTerms) {
    if (hintTerms.has(term)) score += 3;
  }
  if (kind.kind.includes(focusSpec.kind) || focusSpec.kind.includes(kind.kind)) score += 2;
  return score;
}

function pickDynamicCandidateSpecs(kinds: ResourceKindInfo[], focusSpec: KindSpec, focusObj: KubeObject): KindSpec[] {
  const hints = collectRelationHints({ spec: focusObj.spec, status: focusObj.status });
  const hintTerms = new Set(hints.flatMap((hint) => tokens(hint.path)));
  return dedupeResourceKinds(kinds)
    .flatMap((kind) => {
      const score = scoreCandidateKind(kind, focusSpec, hintTerms);
      return score > 0 ? [{ kind, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.kind.kind.localeCompare(b.kind.kind))
    .slice(0, 48)
    .map(({ kind }) => resourceKindToSpec(kind));
}

async function listFocusedRelatedItems(handle: ClusterHandle, focus: Item, namespaces: Set<string> | undefined, warnings: string[]): Promise<Item[]> {
  const resources = await handle.discovery.getResources();
  const candidates = pickDynamicCandidateSpecs(resources.filter((kind) => kind.custom), focus.spec, focus.obj);
  return (await Promise.all(candidates.map((spec) => listKind(handle, spec, namespaces, warnings)))).flat();
}

function metadataMentions(obj: KubeObject, name: string): boolean {
  const values = [
    ...Object.values(obj.metadata.labels ?? {}),
    ...Object.values(obj.metadata.annotations ?? {}),
  ];
  return values.some((value) => value === name);
}

function addFocusedResourceEdges(edges: GraphEdge[], focus: Item | undefined, nodeItems: Map<string, Item>, nodes: Map<string, GraphNode>, byUid: Map<string, string>): void {
  if (!focus) return;
  const actualFocusId = [...nodeItems.entries()].find(([, item]) => sameGvr(item.spec, focus.spec) && item.obj.metadata.name === focus.obj.metadata.name && (item.obj.metadata.namespace ?? '') === (focus.obj.metadata.namespace ?? ''))?.[0];
  if (!actualFocusId) return;
  const focusHints = collectRelationHints({ spec: focus.obj.spec, status: focus.obj.status });
  const focusLabelValues = Object.values(focus.obj.metadata.labels ?? {});
  const focusAnnotationValues = Object.values(focus.obj.metadata.annotations ?? {});

  for (const [id, item] of nodeItems) {
    if (id === actualFocusId) continue;
    const labels = item.obj.metadata.labels ?? {};
    for (const hint of focusHints) {
      if (hint.value === item.obj.metadata.name) {
        addEdge(edges, actualFocusId, id, 'manages', hintLabel(hint.path));
      }
      if (hint.selector && selectorMatches(hint.selector, labels)) {
        addEdge(edges, actualFocusId, id, 'selects', hintLabel(hint.path));
      }
    }

    if (metadataMentions(item.obj, focus.obj.metadata.name)) {
      addEdge(edges, actualFocusId, id, 'manages', 'metadata');
    }

    if (focusLabelValues.includes(item.obj.metadata.name) || focusAnnotationValues.includes(item.obj.metadata.name)) {
      addEdge(edges, actualFocusId, id, 'manages', 'metadata');
    }

    const reverseHints = collectRelationHints({ spec: item.obj.spec, status: item.obj.status });
    if (reverseHints.some((hint) => hint.value === focus.obj.metadata.name || (hint.selector && selectorMatches(hint.selector, focus.obj.metadata.labels)))) {
      addEdge(edges, actualFocusId, id, 'manages', item.spec.kind);
    }

    for (const owner of item.obj.metadata.ownerReferences ?? []) {
      if (owner.uid === focus.obj.metadata.uid) addEdge(edges, actualFocusId, id, 'owns', owner.kind);
    }
    for (const owner of focus.obj.metadata.ownerReferences ?? []) {
      const ownerId = byUid.get(owner.uid);
      if (ownerId) addEdge(edges, ownerId, actualFocusId, 'owns', owner.kind);
    }
  }

  if (nodes.has(actualFocusId)) {
    nodes.get(actualFocusId)!.layer = focus.spec.layer;
  }
}

const edgeIdsByList = new WeakMap<GraphEdge[], Set<string>>();

function addEdge(edges: GraphEdge[], source: string | undefined, target: string | undefined, kind: GraphEdge['kind'], label?: string): boolean {
  if (!source || !target || source === target) return false;
  const id = `${source}->${target}:${kind}:${label ?? ''}`;
  let ids = edgeIdsByList.get(edges);
  if (!ids) {
    ids = new Set();
    edgeIdsByList.set(edges, ids);
  }
  if (ids.has(id)) return true;
  ids.add(id);
  edges.push({ id, source, target, kind, label });
  return true;
}

function setNodeStatus(nodes: Map<string, GraphNode>, id: string | undefined, status: GraphNodeStatus, reason: string): void {
  if (!id) return;
  const node = nodes.get(id);
  if (!node) return;
  if (node.status !== 'error' || status === 'error') {
    node.status = status;
    node.reason = reason;
  }
}

function appName(obj: KubeObject): string | undefined {
  const labels = obj.metadata.labels ?? {};
  return labels['app.kubernetes.io/instance'] ?? labels['app.kubernetes.io/name'] ?? labels.app;
}

function matchesFocus(node: GraphNode, query: FocusQuery): boolean {
  if (query.focusGroup !== undefined && node.ref.group !== query.focusGroup) return false;
  if (query.focusVersion && node.ref.version !== query.focusVersion) return false;
  if (query.focusPlural && node.ref.plural !== query.focusPlural) return false;
  if (query.focusKind && node.ref.kind !== query.focusKind) return false;
  if (query.focusNamespace !== undefined && (node.ref.namespace ?? '') !== query.focusNamespace) return false;
  if (query.focusName && node.ref.name !== query.focusName) return false;
  return !!query.focusName || !!query.focusKind || !!query.focusPlural;
}

function focusGraph(graph: RelationshipGraph, query: FocusQuery): RelationshipGraph {
  const focus = graph.nodes.find((node) => matchesFocus(node, query));
  const hasFocusQuery = !!query.focusName || !!query.focusKind || !!query.focusPlural;
  if (!focus) {
    return hasFocusQuery
      ? { ...graph, nodes: [], edges: [], warnings: [...graph.warnings, `No topology data found for ${query.focusKind ?? 'resource'} ${query.focusNamespace ? `${query.focusNamespace}/` : ''}${query.focusName ?? ''}.`] }
      : graph;
  }
  const depth = Math.max(1, Math.min(4, Number(query.depth ?? 2)));
  const adjacency = new Map<string, Set<string>>();
  const neighborsOf = (id: string): Set<string> => {
    let set = adjacency.get(id);
    if (!set) {
      set = new Set();
      adjacency.set(id, set);
    }
    return set;
  };
  for (const edge of graph.edges) {
    neighborsOf(edge.source).add(edge.target);
    neighborsOf(edge.target).add(edge.source);
  }
  const keep = new Set<string>([focus.id]);
  let frontier = new Set<string>([focus.id]);
  for (let i = 0; i < depth; i++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (keep.has(neighbor)) continue;
        keep.add(neighbor);
        next.add(neighbor);
      }
    }
    frontier = next;
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}

async function buildGraph(handle: ClusterHandle, query: FocusQuery): Promise<RelationshipGraph> {
  const namespaces = query.namespace ? new Set(query.namespace.split(',').map((n) => n.trim()).filter(Boolean)) : undefined;
  const warnings: string[] = [];
  const focusSpec = focusKindSpec(query);
  const listedItemsPromise = Promise.all(KINDS.map((spec) => listKind(handle, spec, namespaces, warnings)));
  const focusItems = focusSpec && !KINDS.some((spec) => sameGvr(spec, focusSpec)) ? await getFocusedItem(handle, focusSpec, query, warnings) : [];
  const dynamicItems = focusItems[0] ? await listFocusedRelatedItems(handle, focusItems[0], namespaces, warnings) : [];
  const listedItems = (await listedItemsPromise).flat();
  const items = [...listedItems, ...focusItems, ...dynamicItems];

  const nodes = new Map<string, GraphNode>(items.map(({ spec, obj }) => {
    const status = statusFor(spec.kind, obj);
    const id = nodeId(handle.contextName, spec, obj);
    const app = appName(obj);
    return [id, {
      id,
      ref: ref(handle.contextName, spec, obj),
      label: obj.metadata.name,
      sublabel: app ? `${sublabel(spec.kind, obj) ?? ''} · app ${app}` : sublabel(spec.kind, obj),
      layer: spec.layer,
      status: status.status,
      reason: status.reason,
    }];
  }));

  const byUid = new Map<string, string>();
  const byKindName = new Map<string, string>();
  const byKindNsName = new Map<string, string>();
  const nodeItems = new Map<string, Item>();
  const pods: Item[] = [];
  const services: Item[] = [];
  const ingresses: Item[] = [];
  const pvcs: Item[] = [];
  for (const item of items) {
    const id = nodeId(handle.contextName, item.spec, item.obj);
    nodeItems.set(id, item);
    if (item.obj.metadata.uid) byUid.set(item.obj.metadata.uid, id);
    byKindName.set(`${item.spec.kind}|${item.obj.metadata.name}`, id);
    byKindNsName.set(`${item.spec.kind}|${item.obj.metadata.namespace ?? ''}|${item.obj.metadata.name}`, id);
    if (item.spec.kind === 'Pod') pods.push(item);
    else if (item.spec.kind === 'Service') services.push(item);
    else if (item.spec.kind === 'Ingress') ingresses.push(item);
    else if (item.spec.kind === 'PersistentVolumeClaim') pvcs.push(item);
  }

  const edges: GraphEdge[] = [];
  for (const [id, { obj }] of nodeItems) {
    for (const owner of obj.metadata.ownerReferences ?? []) {
      addEdge(edges, byUid.get(owner.uid), id, 'owns', owner.kind);
    }
  }
  addFocusedResourceEdges(edges, focusItems[0], nodeItems, nodes, byUid);

  for (const svc of services) {
    const svcId = nodeId(handle.contextName, svc.spec, svc.obj);
    const selector = svc.obj.spec?.selector as Record<string, string> | undefined;
    let matched = 0;
    for (const pod of pods) {
      if (svc.obj.metadata.namespace === pod.obj.metadata.namespace && selectorMatches(selector, pod.obj.metadata.labels)) {
        matched++;
        addEdge(edges, svcId, nodeId(handle.contextName, pod.spec, pod.obj), 'selects');
      }
    }
    if (selector && !matched) {
      setNodeStatus(nodes, svcId, 'warning', 'selector matches 0 pods');
      warnings.push(`Service ${svc.obj.metadata.namespace}/${svc.obj.metadata.name} selector matches 0 pods.`);
    } else if (matched > 0) {
      setNodeStatus(nodes, svcId, 'success', `${matched} pod${matched === 1 ? '' : 's'}`);
    }
  }

  for (const ing of ingresses) {
    const ingId = nodeId(handle.contextName, ing.spec, ing.obj);
    const spec = ing.obj.spec as {
      defaultBackend?: { service?: { name?: string } };
      rules?: Array<{ http?: { paths?: Array<{ backend?: { service?: { name?: string; port?: { name?: string; number?: number } } } }> } }>;
    } | undefined;
    const names = new Set<string>();
    if (spec?.defaultBackend?.service?.name) names.add(spec.defaultBackend.service.name);
    for (const rule of spec?.rules ?? []) {
      for (const path of rule.http?.paths ?? []) {
        if (path.backend?.service?.name) names.add(path.backend.service.name);
      }
    }
    for (const name of names) {
      const target = byKindNsName.get(`Service|${ing.obj.metadata.namespace ?? ''}|${name}`);
      if (!addEdge(edges, ingId, target, 'routes')) {
        setNodeStatus(nodes, ingId, 'warning', `missing Service/${name}`);
        warnings.push(`Ingress ${ing.obj.metadata.namespace}/${ing.obj.metadata.name} points to missing Service ${name}.`);
      }
    }
  }

  for (const pod of pods) {
    const podId = nodeId(handle.contextName, pod.spec, pod.obj);
    const spec = pod.obj.spec as {
      nodeName?: string;
      volumes?: Array<{ persistentVolumeClaim?: { claimName?: string }; configMap?: { name?: string }; secret?: { secretName?: string } }>;
    } | undefined;
    if (spec?.nodeName) addEdge(edges, podId, byKindName.get(`Node|${spec.nodeName}`), 'schedules');
    for (const vol of spec?.volumes ?? []) {
      const claim = vol.persistentVolumeClaim?.claimName;
      if (claim && !addEdge(edges, podId, byKindNsName.get(`PersistentVolumeClaim|${pod.obj.metadata.namespace ?? ''}|${claim}`), 'mounts')) {
        setNodeStatus(nodes, podId, 'warning', `missing PVC/${claim}`);
        warnings.push(`Pod ${pod.obj.metadata.namespace}/${pod.obj.metadata.name} mounts missing PVC ${claim}.`);
      }
      const configMap = vol.configMap?.name;
      if (configMap && !addEdge(edges, podId, byKindNsName.get(`ConfigMap|${pod.obj.metadata.namespace ?? ''}|${configMap}`), 'mounts')) {
        setNodeStatus(nodes, podId, 'warning', `missing ConfigMap/${configMap}`);
        warnings.push(`Pod ${pod.obj.metadata.namespace}/${pod.obj.metadata.name} mounts missing ConfigMap ${configMap}.`);
      }
      const secret = vol.secret?.secretName;
      if (secret && !addEdge(edges, podId, byKindNsName.get(`Secret|${pod.obj.metadata.namespace ?? ''}|${secret}`), 'mounts')) {
        setNodeStatus(nodes, podId, 'warning', `missing Secret/${secret}`);
        warnings.push(`Pod ${pod.obj.metadata.namespace}/${pod.obj.metadata.name} mounts missing Secret ${secret}.`);
      }
    }
  }

  for (const pvc of pvcs) {
    const volumeName = pvc.obj.spec?.volumeName as string | undefined;
    const pvcId = nodeId(handle.contextName, pvc.spec, pvc.obj);
    if (volumeName && !addEdge(edges, pvcId, byKindName.get(`PersistentVolume|${volumeName}`), 'binds')) {
      setNodeStatus(nodes, pvcId, 'warning', `missing PV/${volumeName}`);
      warnings.push(`PVC ${pvc.obj.metadata.namespace}/${pvc.obj.metadata.name} references missing PV ${volumeName}.`);
    }
  }

  return focusGraph({ ctx: handle.contextName, nodes: [...nodes.values()], edges, warnings }, query);
}

export function registerGraphRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string }; Querystring: FocusQuery }>('/api/contexts/:ctx/graph', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await buildGraph(handle, req.query);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
