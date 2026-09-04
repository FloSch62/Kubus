import type { KubeObject, ResourceKindInfo, ResourceRef, UsedByEntry, UsedByResponse } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { installedCrds, optionalItems } from './overview.js';
import type { DigestEntry } from './reference-index.js';
import { hintPath, kindPathCoverage, pathNamesKind, referenceScope, relationPathScore, schemaKindMention, selectorMatches, type RelationHint } from './relation-hints.js';

/**
 * Reverse references: everything in the cluster that points at one object.
 * The forward links (a pod's ConfigMap, a Service's pods) come from the
 * object itself; this walks the other direction across the cached lists so a
 * Secret can say "mounted by 3 Deployments and a CronJob" before it is
 * edited. Everything is read from the shared watcher caches — no API calls
 * beyond the initial lists the overview and list pages already keep warm.
 */

export interface UsedByTarget {
  kind: string;
  name: string;
  namespace?: string;
  /** Labels of the target (pods, workload templates) — matched against selectors. */
  labels?: Record<string, string>;
  /** API group of the target; tells a custom `Node` from the core one. */
  group?: string;
  /** Plural of the target; sharpens field-path matching for custom kinds. */
  plural?: string;
  /** Uid of the target so a self-referencing kind never lists the object itself. */
  uid?: string;
}

export interface UsedByOptions {
  /** Skip the custom-kind scan (tests, or callers that only want the builtin answer). */
  custom?: boolean;
  /** Page size for LIST calls against custom kinds without a warm cache. */
  pageSize?: number;
  /** Objects per custom kind after which the scan stops and reports the kind as partial. */
  scanLimit?: number;
  /** Wall-clock budget for the custom scan; kinds not reached in time count as partial. */
  timeBudgetMs?: number;
}

interface KindSpec {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

const MAX_ITEMS = 200;

const CORE = (plural: string, kind: string, namespaced = true): KindSpec => ({ group: '', version: 'v1', plural, kind, namespaced });

const PODS = CORE('pods', 'Pod');
const SERVICES = CORE('services', 'Service');
const SERVICE_ACCOUNTS = CORE('serviceaccounts', 'ServiceAccount');
const PVCS = CORE('persistentvolumeclaims', 'PersistentVolumeClaim');
const PVS = CORE('persistentvolumes', 'PersistentVolume', false);
const DEPLOYMENTS: KindSpec = { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true };
const STATEFULSETS: KindSpec = { group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet', namespaced: true };
const DAEMONSETS: KindSpec = { group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet', namespaced: true };
const JOBS: KindSpec = { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job', namespaced: true };
const CRONJOBS: KindSpec = { group: 'batch', version: 'v1', plural: 'cronjobs', kind: 'CronJob', namespaced: true };
const INGRESSES: KindSpec = { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', kind: 'Ingress', namespaced: true };
const NETWORK_POLICIES: KindSpec = { group: 'networking.k8s.io', version: 'v1', plural: 'networkpolicies', kind: 'NetworkPolicy', namespaced: true };
const PDBS: KindSpec = { group: 'policy', version: 'v1', plural: 'poddisruptionbudgets', kind: 'PodDisruptionBudget', namespaced: true };
const HPAS: KindSpec = { group: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler', namespaced: true };
const ROLE_BINDINGS: KindSpec = { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'rolebindings', kind: 'RoleBinding', namespaced: true };
const CLUSTER_ROLE_BINDINGS: KindSpec = { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterrolebindings', kind: 'ClusterRoleBinding', namespaced: false };

const GATEWAY_GROUP = 'gateway.networking.k8s.io';

/** Kinds whose pod template can hold config, secret, volume and identity references. */
const POD_TEMPLATE_KINDS = [DEPLOYMENTS, STATEFULSETS, DAEMONSETS, JOBS, CRONJOBS];
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']);

/** Display order: controllers first, then the objects that wrap them, standalone pods last. */
const KIND_RANK: Record<string, number> = {
  Deployment: 0,
  StatefulSet: 1,
  DaemonSet: 2,
  CronJob: 3,
  Job: 4,
  ReplicaSet: 5,
  Service: 6,
  Ingress: 7,
  HTTPRoute: 8,
  GRPCRoute: 9,
  TLSRoute: 10,
  TCPRoute: 11,
  UDPRoute: 12,
  Gateway: 13,
  HorizontalPodAutoscaler: 14,
  PodDisruptionBudget: 15,
  NetworkPolicy: 16,
  RoleBinding: 17,
  ClusterRoleBinding: 18,
  ServiceAccount: 19,
  PersistentVolumeClaim: 20,
  PersistentVolume: 21,
  Pod: 99,
};

interface EnvVar {
  name: string;
  valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } };
}

interface Container {
  name: string;
  env?: EnvVar[];
  envFrom?: Array<{ configMapRef?: { name?: string }; secretRef?: { name?: string } }>;
}

interface Volume {
  name: string;
  configMap?: { name?: string };
  secret?: { secretName?: string };
  persistentVolumeClaim?: { claimName?: string };
  projected?: { sources?: Array<{ configMap?: { name?: string }; secret?: { name?: string } }> };
}

interface PodSpecShape {
  containers?: Container[];
  initContainers?: Container[];
  ephemeralContainers?: Container[];
  volumes?: Volume[];
  serviceAccountName?: string;
  serviceAccount?: string;
  nodeName?: string;
  priorityClassName?: string;
  runtimeClassName?: string;
  imagePullSecrets?: Array<{ name?: string }>;
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}

interface Relation {
  relation: string;
  detail?: string;
}

function podSpecOf(kind: string, obj: KubeObject): PodSpecShape | undefined {
  const spec = obj.spec as Record<string, unknown> | undefined;
  if (!spec) return undefined;
  if (kind === 'Pod') return spec as PodSpecShape;
  if (kind === 'CronJob') {
    return ((spec.jobTemplate as { spec?: { template?: { spec?: PodSpecShape } } } | undefined)?.spec?.template?.spec);
  }
  return (spec.template as { spec?: PodSpecShape } | undefined)?.spec;
}

/** Labels a selector is matched against: the pod's own, or a workload's pod template labels. */
export function selectableLabels(kind: string, obj: KubeObject): Record<string, string> | undefined {
  if (kind === 'Pod') return obj.metadata.labels;
  const spec = obj.spec as Record<string, unknown> | undefined;
  if (kind === 'CronJob') {
    return (spec?.jobTemplate as { spec?: { template?: { metadata?: { labels?: Record<string, string> } } } } | undefined)?.spec?.template?.metadata?.labels;
  }
  return (spec?.template as { metadata?: { labels?: Record<string, string> } } | undefined)?.metadata?.labels;
}

/** Kubernetes label-selector semantics: every matchLabels pair and every expression must hold. */
export function labelSelectorMatches(selector: LabelSelector | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector) return false;
  const have = labels ?? {};
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (have[key] !== value) return false;
  }
  for (const expr of selector.matchExpressions ?? []) {
    const actual = have[expr.key];
    switch (expr.operator) {
      case 'In':
        if (actual === undefined || !(expr.values ?? []).includes(actual)) return false;
        break;
      case 'NotIn':
        if (actual !== undefined && (expr.values ?? []).includes(actual)) return false;
        break;
      case 'Exists':
        if (actual === undefined) return false;
        break;
      case 'DoesNotExist':
        if (actual !== undefined) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** A plain `map` selector (Services): every pair must match; an empty map selects nothing. */
function mapSelectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  const entries = Object.entries(selector ?? {});
  return entries.length > 0 && entries.every(([key, value]) => labels?.[key] === value);
}

function containersOf(spec: PodSpecShape): Container[] {
  return [...(spec.initContainers ?? []), ...(spec.containers ?? []), ...(spec.ephemeralContainers ?? [])];
}

/** Every way a pod spec references the target (ConfigMap, Secret, SA, PVC, Node, classes). */
export function podSpecRelations(spec: PodSpecShape | undefined, target: UsedByTarget): Relation[] {
  if (!spec) return [];
  const out: Relation[] = [];
  const { kind, name } = target;
  if (kind === 'ConfigMap' || kind === 'Secret') {
    for (const volume of spec.volumes ?? []) {
      const direct = kind === 'ConfigMap' ? volume.configMap?.name : volume.secret?.secretName;
      if (direct === name) out.push({ relation: 'mounts', detail: `volume ${volume.name}` });
      for (const source of volume.projected?.sources ?? []) {
        const projected = kind === 'ConfigMap' ? source.configMap?.name : source.secret?.name;
        if (projected === name) out.push({ relation: 'mounts', detail: `projected volume ${volume.name}` });
      }
    }
    for (const container of containersOf(spec)) {
      for (const env of container.env ?? []) {
        const ref = kind === 'ConfigMap' ? env.valueFrom?.configMapKeyRef?.name : env.valueFrom?.secretKeyRef?.name;
        if (ref === name) out.push({ relation: 'env', detail: `${container.name}: ${env.name}` });
      }
      for (const from of container.envFrom ?? []) {
        const ref = kind === 'ConfigMap' ? from.configMapRef?.name : from.secretRef?.name;
        if (ref === name) out.push({ relation: 'env', detail: `${container.name}: all keys` });
      }
    }
    if (kind === 'Secret' && (spec.imagePullSecrets ?? []).some((s) => s.name === name)) {
      out.push({ relation: 'image pull secret' });
    }
  } else if (kind === 'ServiceAccount') {
    const account = spec.serviceAccountName ?? spec.serviceAccount;
    if (account === name) out.push({ relation: 'runs as' });
    else if (!account && name === 'default') out.push({ relation: 'runs as', detail: 'implicit default' });
  } else if (kind === 'PersistentVolumeClaim') {
    for (const volume of spec.volumes ?? []) {
      if (volume.persistentVolumeClaim?.claimName === name) out.push({ relation: 'mounts', detail: `volume ${volume.name}` });
    }
  } else if (kind === 'Node') {
    if (spec.nodeName === name) out.push({ relation: 'scheduled on' });
  } else if (kind === 'PriorityClass') {
    if (spec.priorityClassName === name) out.push({ relation: 'priority' });
  } else if (kind === 'RuntimeClass') {
    if (spec.runtimeClassName === name) out.push({ relation: 'runtime' });
  }
  return out;
}

interface IngressShape {
  ingressClassName?: string;
  tls?: Array<{ secretName?: string; hosts?: string[] }>;
  defaultBackend?: { service?: { name?: string } };
  rules?: Array<{ host?: string; http?: { paths?: Array<{ path?: string; backend?: { service?: { name?: string } } }> } }>;
}

function ingressRelations(ingress: KubeObject, target: UsedByTarget): Relation[] {
  const spec = (ingress.spec ?? {}) as IngressShape;
  const out: Relation[] = [];
  if (target.kind === 'Service') {
    if (spec.defaultBackend?.service?.name === target.name) out.push({ relation: 'routes to', detail: 'default backend' });
    for (const rule of spec.rules ?? []) {
      for (const path of rule.http?.paths ?? []) {
        if (path.backend?.service?.name === target.name) {
          out.push({ relation: 'routes to', detail: `${rule.host ?? '*'}${path.path ?? '/'}` });
        }
      }
    }
  } else if (target.kind === 'Secret') {
    for (const tls of spec.tls ?? []) {
      if (tls.secretName === target.name) out.push({ relation: 'TLS', detail: (tls.hosts ?? []).join(', ') || undefined });
    }
  } else if (target.kind === 'IngressClass') {
    if (spec.ingressClassName === target.name) out.push({ relation: 'class' });
  }
  return out;
}

interface RouteShape {
  parentRefs?: Array<{ group?: string; kind?: string; name?: string; namespace?: string; sectionName?: string }>;
  hostnames?: string[];
  rules?: Array<{
    matches?: Array<{ path?: { value?: string } }>;
    backendRefs?: Array<{ group?: string; kind?: string; name?: string; namespace?: string; port?: number }>;
  }>;
}

/** A backendRef means the core Service only with the core group (empty or unset). */
function isCoreServiceRef(ref: { group?: string; kind?: string }): boolean {
  return (ref.kind ?? 'Service') === 'Service' && !ref.group;
}

/** A parentRef means a Gateway API Gateway only with that API group (the default). */
function isGatewayRef(ref: { group?: string; kind?: string }): boolean {
  return (ref.kind ?? 'Gateway') === 'Gateway' && (ref.group ?? GATEWAY_GROUP) === GATEWAY_GROUP;
}

function routeRelations(route: KubeObject, target: UsedByTarget): Relation[] {
  const spec = (route.spec ?? {}) as RouteShape;
  const routeNamespace = route.metadata.namespace;
  const out: Relation[] = [];
  if (target.kind === 'Service') {
    for (const rule of spec.rules ?? []) {
      for (const backend of rule.backendRefs ?? []) {
        if (!isCoreServiceRef(backend) || backend.name !== target.name) continue;
        if ((backend.namespace ?? routeNamespace) !== target.namespace) continue;
        const paths = (rule.matches ?? []).map((m) => m.path?.value).filter((p): p is string => !!p);
        const hosts = (spec.hostnames ?? []).join(', ');
        const detail = [hosts || undefined, paths.length ? paths.join(', ') : undefined].filter(Boolean).join(' ');
        out.push({ relation: 'routes to', detail: detail || undefined });
      }
    }
  } else if (target.kind === 'Gateway') {
    for (const parent of spec.parentRefs ?? []) {
      if (!isGatewayRef(parent) || parent.name !== target.name) continue;
      if ((parent.namespace ?? routeNamespace) !== target.namespace) continue;
      out.push({ relation: 'attached to', detail: parent.sectionName ? `listener ${parent.sectionName}` : undefined });
    }
  }
  return out;
}

function roleRefRelations(binding: KubeObject, target: UsedByTarget): Relation[] {
  const ref = (binding as { roleRef?: { kind?: string; name?: string } }).roleRef;
  if (ref?.kind !== target.kind || ref.name !== target.name) return [];
  if (target.kind === 'Role' && binding.metadata.namespace !== target.namespace) return [];
  const subjects = (binding as { subjects?: Array<{ kind?: string; name?: string }> }).subjects ?? [];
  const detail = subjects.length ? subjects.slice(0, 3).map((s) => `${s.kind ?? 'Subject'} ${s.name ?? '?'}`).join(', ') + (subjects.length > 3 ? ` +${subjects.length - 3}` : '') : undefined;
  return [{ relation: 'grants', detail }];
}

function bindingRelations(binding: KubeObject, target: UsedByTarget): Relation[] {
  const subjects = ((binding as { subjects?: Array<{ kind?: string; name?: string; namespace?: string }> }).subjects ?? []);
  const roleRef = (binding as { roleRef?: { kind?: string; name?: string } }).roleRef;
  const hit = subjects.some((s) => s.kind === 'ServiceAccount' && s.name === target.name && (s.namespace ?? binding.metadata.namespace) === target.namespace);
  return hit ? [{ relation: 'grants', detail: roleRef ? `${roleRef.kind}/${roleRef.name}` : undefined }] : [];
}

function serviceAccountRelations(account: KubeObject, target: UsedByTarget): Relation[] {
  if (target.kind !== 'Secret' || account.metadata.namespace !== target.namespace) return [];
  const out: Relation[] = [];
  const secrets = (account as { secrets?: Array<{ name?: string }> }).secrets ?? [];
  const pullSecrets = (account as { imagePullSecrets?: Array<{ name?: string }> }).imagePullSecrets ?? [];
  if (secrets.some((s) => s.name === target.name)) out.push({ relation: 'token' });
  if (pullSecrets.some((s) => s.name === target.name)) out.push({ relation: 'image pull secret' });
  return out;
}

function pvcRelations(pvc: KubeObject, target: UsedByTarget): Relation[] {
  const spec = (pvc.spec ?? {}) as { storageClassName?: string; volumeName?: string };
  if (target.kind === 'StorageClass') {
    const cls = spec.storageClassName ?? pvc.metadata.annotations?.['volume.beta.kubernetes.io/storage-class'];
    return cls === target.name ? [{ relation: 'storage class' }] : [];
  }
  if (target.kind === 'PersistentVolume') return spec.volumeName === target.name ? [{ relation: 'bound to' }] : [];
  return [];
}

function pvRelations(pv: KubeObject, target: UsedByTarget): Relation[] {
  if (target.kind !== 'StorageClass') return [];
  const spec = (pv.spec ?? {}) as { storageClassName?: string };
  return spec.storageClassName === target.name ? [{ relation: 'storage class' }] : [];
}

function serviceRelations(service: KubeObject, target: UsedByTarget): Relation[] {
  if (service.metadata.namespace !== target.namespace) return [];
  const selector = (service.spec as { selector?: Record<string, string> } | undefined)?.selector;
  return mapSelectorMatches(selector, target.labels) ? [{ relation: 'exposes' }] : [];
}

function pdbRelations(pdb: KubeObject, target: UsedByTarget): Relation[] {
  if (pdb.metadata.namespace !== target.namespace) return [];
  const spec = (pdb.spec ?? {}) as { selector?: LabelSelector; minAvailable?: number | string; maxUnavailable?: number | string };
  if (!labelSelectorMatches(spec.selector, target.labels)) return [];
  const detail = spec.minAvailable !== undefined ? `min available ${spec.minAvailable}` : spec.maxUnavailable !== undefined ? `max unavailable ${spec.maxUnavailable}` : undefined;
  return [{ relation: 'protects', detail }];
}

function networkPolicyRelations(policy: KubeObject, target: UsedByTarget): Relation[] {
  if (policy.metadata.namespace !== target.namespace) return [];
  const spec = (policy.spec ?? {}) as { podSelector?: LabelSelector; policyTypes?: string[]; ingress?: unknown[]; egress?: unknown[] };
  const selector = spec.podSelector ?? {};
  const selectsAll = !Object.keys(selector.matchLabels ?? {}).length && !(selector.matchExpressions ?? []).length;
  if (!selectsAll && !labelSelectorMatches(selector, target.labels)) return [];
  const types = spec.policyTypes?.length ? spec.policyTypes : ['Ingress', ...(spec.egress ? ['Egress'] : [])];
  return [{ relation: 'applies to', detail: `${types.join(' + ')}${selectsAll ? ' · all pods in namespace' : ''}` }];
}

function hpaRelations(hpa: KubeObject, target: UsedByTarget): Relation[] {
  if (hpa.metadata.namespace !== target.namespace) return [];
  const ref = (hpa.spec as { scaleTargetRef?: { kind?: string; name?: string } } | undefined)?.scaleTargetRef;
  if (ref?.kind !== target.kind || ref.name !== target.name) return [];
  const spec = hpa.spec as { minReplicas?: number; maxReplicas?: number } | undefined;
  return [{ relation: 'scales', detail: `${spec?.minReplicas ?? 1}–${spec?.maxReplicas ?? '?'} replicas` }];
}

function preferVersion(kinds: ResourceKindInfo[]): ResourceKindInfo | undefined {
  const score = (v: string): number => {
    const m = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(v);
    if (!m) return 0;
    return (m[2] === 'alpha' ? 1 : m[2] === 'beta' ? 2 : 3) * 1000 + Number(m[1]) * 10 + Number(m[3] ?? 0);
  };
  return kinds.reduce<ResourceKindInfo | undefined>((best, kind) => (!best || score(kind.version) > score(best.version) ? kind : best), undefined);
}

/** Gateway API route kinds the cluster serves (absent on clusters without the CRDs). */
async function gatewayRouteKinds(handle: ClusterHandle, kinds: string[]): Promise<KindSpec[]> {
  const resources = await handle.discovery.getResources().catch(() => [] as ResourceKindInfo[]);
  const out: KindSpec[] = [];
  for (const kind of kinds) {
    const best = preferVersion(resources.filter((r) => r.group === GATEWAY_GROUP && r.kind === kind && r.verbs.includes('list')));
    if (best) out.push({ group: best.group, version: best.version, plural: best.plural, kind: best.kind, namespaced: best.namespaced });
  }
  return out;
}

type Matcher = (obj: KubeObject, target: UsedByTarget) => Relation[];

/** Which cached lists to scan for a target kind, and how each candidate relates. */
async function sourcesFor(handle: ClusterHandle, target: UsedByTarget): Promise<Array<{ spec: KindSpec; match: Matcher }>> {
  const podSources = [PODS, ...POD_TEMPLATE_KINDS].map((spec) => ({ spec, match: (obj: KubeObject, t: UsedByTarget) => podSpecRelations(podSpecOf(spec.kind, obj), t) }));
  switch (target.kind) {
    case 'ConfigMap':
      return podSources;
    case 'Secret':
      return [...podSources, { spec: INGRESSES, match: ingressRelations }, { spec: SERVICE_ACCOUNTS, match: serviceAccountRelations }];
    case 'ServiceAccount':
      return [...podSources, { spec: ROLE_BINDINGS, match: bindingRelations }, { spec: CLUSTER_ROLE_BINDINGS, match: bindingRelations }];
    case 'PersistentVolumeClaim':
      return podSources;
    case 'Node':
      return [{ spec: PODS, match: (obj, t) => podSpecRelations(podSpecOf('Pod', obj), t) }];
    case 'PriorityClass':
    case 'RuntimeClass':
      return podSources;
    case 'Service': {
      const routes = await gatewayRouteKinds(handle, ['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute']);
      return [{ spec: INGRESSES, match: ingressRelations }, ...routes.map((spec) => ({ spec, match: routeRelations }))];
    }
    case 'Gateway': {
      const routes = await gatewayRouteKinds(handle, ['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute']);
      return routes.map((spec) => ({ spec, match: routeRelations }));
    }
    case 'StorageClass':
      return [{ spec: PVCS, match: pvcRelations }, { spec: PVS, match: pvRelations }];
    case 'PersistentVolume':
      return [{ spec: PVCS, match: pvcRelations }];
    case 'IngressClass':
      return [{ spec: INGRESSES, match: ingressRelations }];
    case 'Role':
      return [{ spec: ROLE_BINDINGS, match: roleRefRelations }];
    case 'ClusterRole':
      return [{ spec: ROLE_BINDINGS, match: roleRefRelations }, { spec: CLUSTER_ROLE_BINDINGS, match: roleRefRelations }];
    case 'Pod':
      return [{ spec: SERVICES, match: serviceRelations }, { spec: PDBS, match: pdbRelations }, { spec: NETWORK_POLICIES, match: networkPolicyRelations }];
    default:
      if (WORKLOAD_KINDS.has(target.kind)) {
        return [
          { spec: SERVICES, match: serviceRelations },
          { spec: HPAS, match: hpaRelations },
          { spec: PDBS, match: pdbRelations },
          { spec: NETWORK_POLICIES, match: networkPolicyRelations },
        ];
      }
      return [];
  }
}

/** Kinds this endpoint can answer for — the client hides the section elsewhere. */
export const USED_BY_KINDS = new Set([
  'ConfigMap',
  'Secret',
  'ServiceAccount',
  'PersistentVolumeClaim',
  'PersistentVolume',
  'Node',
  'PriorityClass',
  'RuntimeClass',
  'Service',
  'Gateway',
  'StorageClass',
  'IngressClass',
  'Role',
  'ClusterRole',
  'Pod',
  ...WORKLOAD_KINDS,
]);

function refFor(ctx: string, spec: KindSpec, obj: KubeObject): ResourceRef {
  return {
    ctx,
    group: spec.group,
    version: spec.version,
    plural: spec.plural,
    kind: spec.kind,
    name: obj.metadata.name,
    namespace: spec.namespaced ? obj.metadata.namespace : undefined,
    uid: obj.metadata.uid,
  };
}

/** Whether a candidate can reference a namespaced target at all (cross-namespace kinds check inside their matcher). */
function inScope(spec: KindSpec, obj: KubeObject, target: UsedByTarget): boolean {
  if (!target.namespace || !spec.namespaced) return true;
  if (spec.group === GATEWAY_GROUP || spec.kind === 'RoleBinding') return true;
  return obj.metadata.namespace === target.namespace;
}

/*
 * Custom kinds. A CRD gives no matcher to hard-code, so the reverse lookup
 * is inferred: a custom object references the target when one of its spec
 * or status fields is named after the target's kind and holds the target's
 * name (`spec.members[].node` on a TopoLink → TopoNode `leaf1`), when such
 * a field holds a label selector that matches the target's labels
 * (`leafNodeSelectors: ["role=leaf"]`), or when a label keyed after the kind
 * carries the name (`services.example.com/virtualnetwork: vn-a`).
 *
 * Reads come from two live caches: the search index (names and labels of
 * every custom kind, when the transport multiplexes watches) answers the
 * label relations and says which kinds have objects in scope at all, and
 * the reference index (digests of the kinds worth scanning, built on first
 * use) answers names and selectors. Only the very first lookup of a kind
 * pays for a list; everything after is memory.
 */

const CUSTOM_CANDIDATE_LIMIT = 128;
const CUSTOM_CONCURRENCY = 8;
const CUSTOM_TIME_BUDGET_MS = 8_000;

/** Builtin kinds custom resources commonly point at; their names stay in the digests. */
export const BUILTIN_REFERENCE_KINDS = [
  'ConfigMap',
  'Secret',
  'Service',
  'ServiceAccount',
  'Node',
  'Namespace',
  'PersistentVolumeClaim',
  'PersistentVolume',
  'StorageClass',
  'PriorityClass',
  'RuntimeClass',
  'IngressClass',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Pod',
  'Ingress',
  'Gateway',
];

interface CrdShape {
  group?: string;
  scope?: string;
  names?: { kind?: string; plural?: string };
  versions?: Array<{ name?: string; served?: boolean; storage?: boolean; schema?: { openAPIV3Schema?: unknown } }>;
}

interface KindTarget {
  kind: string;
  plural: string;
}

/** The operator family of an API group: `core.eda.nokia.com` and `interfaces.eda.nokia.com` both belong to `eda.nokia.com`. */
export function groupFamily(group: string): string {
  const labels = group.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : group;
}

/**
 * Installed custom kinds worth scanning, most promising first:
 *
 * 1. kinds whose schema spells out the target kind, in a field name or its
 *    description, own group ahead of others;
 * 2. kinds of the target's group or operator family with a spec field named
 *    after the kind's head word (`node` on a TopoLink, for a TopoNode), then
 *    those where such a field only appears under status;
 * 3. unless labels come from the search index, the rest of the target's own
 *    group, because operators tag children with parent labels the schema
 *    never mentions.
 *
 * A head-word match from an unrelated group is dropped: a storage driver's
 * `nodeID` is about cluster nodes, not TopoNodes. The cap keeps a 300-CRD
 * cluster from turning one drawer into a hundred lists; the time budget
 * trims from the bottom of this order.
 */
export function customCandidates(crds: KubeObject[], target: UsedByTarget, exclude: KindSpec[] = [], opts: { labelsFromIndex?: boolean } = {}): KindSpec[] {
  const out: Array<KindSpec & { rank: number }> = [];
  const family = target.group ? groupFamily(target.group) : undefined;
  for (const crd of crds) {
    const spec = crd.spec as CrdShape | undefined;
    const versions = spec?.versions ?? [];
    const version = versions.find((v) => v.storage && v.served) ?? versions.find((v) => v.served);
    if (!spec?.group || !spec.names?.plural || !spec.names.kind || !version?.name) continue;
    if (exclude.some((e) => e.group === spec.group && e.plural === spec.names?.plural)) continue;
    const sameGroup = spec.group === target.group;
    const sameFamily = sameGroup || (family !== undefined && groupFamily(spec.group) === family);
    const mention = schemaKindMention(version.schema?.openAPIV3Schema, target.kind);
    let rank: number;
    if (mention?.strength === 'strong') rank = sameGroup ? 0 : 1;
    else if (mention && sameFamily) rank = (mention.inSpec ? 2 : 4) + (sameGroup ? 0 : 1);
    else if (sameGroup && !opts.labelsFromIndex) rank = 6;
    else continue;
    out.push({ group: spec.group, version: version.name, plural: spec.names.plural, kind: spec.names.kind, namespaced: spec.scope === 'Namespaced', rank });
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.kind.localeCompare(b.kind))
    .slice(0, CUSTOM_CANDIDATE_LIMIT)
    .map(({ rank: _rank, ...spec }) => spec);
}

/**
 * Whether a field names the target kind at least as well as any other
 * installed kind: `spec.nodeProfile` covers two words of NodeProfile and one
 * of TopoNode, so a TopoNode with that name is not what the field points at.
 * Ties stand (a `node` field may mean a TopoNode as well as a longhorn
 * Node). A sibling `kind` field settles it outright.
 */
function pathPrefersKind(hint: RelationHint, target: KindTarget, rivals: KindTarget[]): boolean {
  if (relationPathScore(hint, target) <= 0) return false;
  if (hint.referenceKind) return true;
  if (!pathNamesKind(hint.path, target.kind)) return false;
  // Judge by the last segment when it names a kind: `spec.links[].local.node`
  // is about a node, whatever the container is called.
  const scope = referenceScope(hint.path, (segment) => pathNamesKind(segment, target.kind) || rivals.some((rival) => pathNamesKind(segment, rival.kind)));
  const coverage = kindPathCoverage(scope, target);
  return coverage > 0 && !rivals.some((rival) => rival.kind !== target.kind && kindPathCoverage(scope, rival) > coverage);
}

/**
 * Whether an object in `namespace` may reference the target: a cluster-scoped
 * target from anywhere, a namespaced one from its own namespace, from
 * cluster-scoped kinds, or through a reference that names the namespace.
 */
function scopeAllows(namespace: string | undefined, target: UsedByTarget, explicitNamespace?: string): boolean {
  if (!target.namespace) return true;
  if (explicitNamespace) return explicitNamespace === target.namespace;
  return namespace === undefined || namespace === target.namespace;
}

/** Every inferred way one digested object points at the target. */
export function digestRelations(entry: DigestEntry, target: UsedByTarget, rivals: KindTarget[], opts: { labels?: boolean } = {}): Relation[] {
  if (target.uid && entry.uid === target.uid) return [];
  const kindTarget: KindTarget = { kind: target.kind, plural: target.plural ?? '' };
  const relations: Relation[] = [];
  const seen = new Set<string>();
  const add = (relation: string, detail: string) => {
    const id = `${relation}:${detail}`;
    if (seen.has(id)) return;
    seen.add(id);
    relations.push({ relation, detail });
  };
  for (const hint of entry.digest.hints) {
    if (hint.value !== target.name || !scopeAllows(entry.namespace, target, hint.referenceNamespace)) continue;
    if (pathPrefersKind(hint, kindTarget, rivals)) add('references', hintPath(hint.path));
  }
  if (target.labels && scopeAllows(entry.namespace, target)) {
    for (const { path, selector } of entry.digest.selectors) {
      if (selectorMatches(selector, target.labels) && pathNamesKind(path, target.kind)) add('selects', hintPath(path));
    }
  }
  if (opts.labels !== false && scopeAllows(entry.namespace, target)) {
    for (const [key, value] of Object.entries(entry.labels ?? {})) {
      if (value === target.name && pathPrefersKind({ path: key, value }, kindTarget, rivals)) add('labeled', key);
    }
  }
  return relations;
}

interface CustomScan {
  items: UsedByEntry[];
  unavailable: string[];
  /** Kinds whose index was still being built when the budget ran out. */
  partial: string[];
  /** Time spent on custom kinds; zero when nothing had to be listed. */
  scanMs: number;
}

async function mapLimit<T, R>(inputs: T[], limit: number, fn: (input: T) => Promise<R>): Promise<R[]> {
  const results = Array.from({ length: inputs.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    while (next < inputs.length) {
      const i = next++;
      results[i] = await fn(inputs[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function entryRef(ctx: string, spec: KindSpec, entry: { name: string; namespace?: string; uid?: string }): ResourceRef {
  return {
    ctx,
    group: spec.group,
    version: spec.version,
    plural: spec.plural,
    kind: spec.kind,
    name: entry.name,
    namespace: spec.namespaced ? entry.namespace : undefined,
    uid: entry.uid ?? '',
  };
}

/** Rows keyed by object, so a kind answered twice (labels from one cache, names from another) still yields one line. */
function mergeRows(rows: Map<string, UsedByEntry>, ref: ResourceRef, relations: Relation[]): void {
  const id = `${ref.kind}|${ref.namespace ?? ''}|${ref.name}`;
  const existing = rows.get(id);
  const words = [...new Set([...(existing?.relation.split(' · ') ?? []), ...relations.map((r) => r.relation)])];
  const details = [...new Set([...(existing?.detail?.split(', ') ?? []), ...relations.map((r) => r.detail).filter((d): d is string => !!d)])];
  rows.set(id, { ref, relation: words.join(' · '), detail: details.length ? details.join(', ') : undefined });
}

async function scanCustomKinds(handle: ClusterHandle, target: UsedByTarget, exclude: KindSpec[], opts: UsedByOptions): Promise<CustomScan> {
  const empty: CustomScan = { items: [], unavailable: [], partial: [], scanMs: 0 };
  const started = Date.now();
  let crds: KubeObject[];
  try {
    crds = await installedCrds(handle);
  } catch {
    return empty;
  }
  const search = handle.searchIndex;
  search.warm();
  const indexLive = search.customKindsLive();
  const crdKinds = crds.flatMap((crd) => {
    const names = (crd.spec as CrdShape | undefined)?.names;
    return names?.kind && names.plural ? [{ kind: names.kind, plural: names.plural }] : [];
  });
  handle.referenceIndex.setVocabulary([...crdKinds.map((k) => k.kind), ...BUILTIN_REFERENCE_KINDS]);
  const kindTarget: KindTarget = { kind: target.kind, plural: target.plural ?? '' };
  const rows = new Map<string, UsedByEntry>();

  // Labels: every indexed kind at once, from metadata the search index already holds.
  if (indexLive) {
    for (const entry of search.liveEntries()) {
      if (!entry.kind.custom || !entry.labels || (target.uid && entry.uid === target.uid) || !scopeAllows(entry.namespace, target)) continue;
      for (const [key, value] of Object.entries(entry.labels)) {
        if (value !== target.name || !pathPrefersKind({ path: key, value }, kindTarget, crdKinds)) continue;
        mergeRows(rows, entryRef(handle.contextName, entry.kind, entry), [{ relation: 'labeled', detail: key }]);
      }
    }
  }

  // Names and selectors: the kinds whose schema can point at this one, skipping kinds the index knows to be empty in scope.
  const candidates = customCandidates(crds, target, exclude, { labelsFromIndex: indexLive }).filter(
    (spec) => !indexLive || !search.isLive(spec.group, spec.plural) || search.entriesForKind(spec.group, spec.plural).some((entry) => scopeAllows(entry.namespace, target)),
  );
  const deadline = Date.now() + (opts.timeBudgetMs ?? CUSTOM_TIME_BUDGET_MS);
  const unavailable: string[] = [];
  const partial: string[] = [];
  await mapLimit(candidates, CUSTOM_CONCURRENCY, async (spec) => {
    const lookup = await handle.referenceIndex.lookup(spec, { deadline });
    if (lookup.unavailable) {
      unavailable.push(spec.kind);
      return;
    }
    if (!lookup.ready) {
      partial.push(spec.kind);
      return;
    }
    for (const entry of lookup.entries) {
      const relations = digestRelations(entry, target, crdKinds, { labels: !indexLive });
      if (relations.length) mergeRows(rows, entryRef(handle.contextName, spec, entry), relations);
    }
  });
  return { items: [...rows.values()], unavailable, partial, scanMs: candidates.length ? Date.now() - started : 0 };
}

export async function computeUsedBy(handle: ClusterHandle, target: UsedByTarget, opts: UsedByOptions = {}): Promise<UsedByResponse> {
  const sources = await sourcesFor(handle, target);
  const acquired = sources.map((source) => ({ source, handle: handle.watchers.acquire(source.spec.group, source.spec.version, source.spec.plural) }));
  try {
    const [results, custom] = await Promise.all([
      Promise.all(acquired.map((a) => optionalItems(a.handle.watcher))),
      opts.custom === false ? Promise.resolve<CustomScan>({ items: [], unavailable: [], partial: [], scanMs: 0 }) : scanCustomKinds(handle, target, sources.map((s) => s.spec), opts),
    ]);
    const items: UsedByEntry[] = [];
    const unavailable: string[] = [];
    results.forEach((result, i) => {
      const { spec, match } = acquired[i]!.source;
      if (result.unavailable) {
        unavailable.push(spec.kind);
        return;
      }
      for (const obj of result.items) {
        if (!inScope(spec, obj, target)) continue;
        // Cached objects carry apiVersion but not always kind; matchers key off the spec.
        const relations = match({ ...obj, kind: spec.kind }, target);
        if (!relations.length) continue;
        // One row per object: relation words deduped, details joined.
        const words = [...new Set(relations.map((r) => r.relation))].join(' · ');
        const details = [...new Set(relations.map((r) => r.detail).filter((d): d is string => !!d))];
        items.push({ ref: refFor(handle.contextName, spec, obj), relation: words, detail: details.length ? details.join(', ') : undefined });
      }
    });
    items.push(...custom.items);
    unavailable.push(...custom.unavailable);
    items.sort(
      (a, b) =>
        (KIND_RANK[a.ref.kind] ?? 50) - (KIND_RANK[b.ref.kind] ?? 50) ||
        a.ref.kind.localeCompare(b.ref.kind) ||
        (a.ref.namespace ?? '').localeCompare(b.ref.namespace ?? '') ||
        a.ref.name.localeCompare(b.ref.name),
    );
    const truncated = Math.max(0, items.length - MAX_ITEMS);
    return {
      items: items.slice(0, MAX_ITEMS),
      unavailable,
      partial: custom.partial.length ? custom.partial : undefined,
      scanMs: custom.scanMs > 0 ? custom.scanMs : undefined,
      truncated,
    };
  } finally {
    for (const a of acquired) a.handle.release();
  }
}
