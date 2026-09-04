import type { KubeObject, ResourceKindInfo, ResourceRef, UsedByEntry, UsedByResponse } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { optionalItems } from './overview.js';

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

function routeRelations(route: KubeObject, target: UsedByTarget): Relation[] {
  const spec = (route.spec ?? {}) as RouteShape;
  const routeNamespace = route.metadata.namespace;
  const out: Relation[] = [];
  if (target.kind === 'Service') {
    for (const rule of spec.rules ?? []) {
      for (const backend of rule.backendRefs ?? []) {
        const kind = backend.kind ?? 'Service';
        if (kind !== 'Service' || backend.name !== target.name) continue;
        if ((backend.namespace ?? routeNamespace) !== target.namespace) continue;
        const paths = (rule.matches ?? []).map((m) => m.path?.value).filter((p): p is string => !!p);
        const hosts = (spec.hostnames ?? []).join(', ');
        const detail = [hosts || undefined, paths.length ? paths.join(', ') : undefined].filter(Boolean).join(' ');
        out.push({ relation: 'routes to', detail: detail || undefined });
      }
    }
  } else if (target.kind === 'Gateway') {
    for (const parent of spec.parentRefs ?? []) {
      const kind = parent.kind ?? 'Gateway';
      if (kind !== 'Gateway' || parent.name !== target.name) continue;
      if ((parent.namespace ?? routeNamespace) !== target.namespace) continue;
      out.push({ relation: 'attached to', detail: parent.sectionName ? `listener ${parent.sectionName}` : undefined });
    }
  }
  return out;
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

export async function computeUsedBy(handle: ClusterHandle, target: UsedByTarget): Promise<UsedByResponse> {
  const sources = await sourcesFor(handle, target);
  const acquired = sources.map((source) => ({ source, handle: handle.watchers.acquire(source.spec.group, source.spec.version, source.spec.plural) }));
  try {
    const results = await Promise.all(acquired.map((a) => optionalItems(a.handle.watcher)));
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
    items.sort(
      (a, b) =>
        (KIND_RANK[a.ref.kind] ?? 50) - (KIND_RANK[b.ref.kind] ?? 50) ||
        (a.ref.namespace ?? '').localeCompare(b.ref.namespace ?? '') ||
        a.ref.name.localeCompare(b.ref.name),
    );
    const truncated = Math.max(0, items.length - MAX_ITEMS);
    return { items: items.slice(0, MAX_ITEMS), unavailable, truncated };
  } finally {
    for (const a of acquired) a.handle.release();
  }
}
