/**
 * Static metadata for builtin resource kinds: navigation grouping and
 * per-kind list column presets. CRDs are discovered dynamically and get
 * the generic column set.
 */

export interface GVK {
  group: string; // '' for core
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

/** Compact, unambiguous group/version/kind label for resource UI. */
export function gvkLabel(gvk: Pick<GVK, 'group' | 'version' | 'kind'>): string {
  return `${gvk.group || 'core'}/${gvk.version}/${gvk.kind}`;
}

export interface NavGroup {
  title: string;
  kinds: GVK[];
}

const core = (plural: string, kind: string, namespaced = true): GVK => ({
  group: '',
  version: 'v1',
  plural,
  kind,
  namespaced,
});

export const BUILTIN_NAV_GROUPS: NavGroup[] = [
  {
    title: 'Cluster',
    kinds: [
      core('nodes', 'Node', false),
      core('namespaces', 'Namespace', false),
      core('events', 'Event'),
    ],
  },
  {
    title: 'Workloads',
    kinds: [
      core('pods', 'Pod'),
      { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true },
      { group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet', namespaced: true },
      { group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet', namespaced: true },
      { group: 'apps', version: 'v1', plural: 'replicasets', kind: 'ReplicaSet', namespaced: true },
      { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job', namespaced: true },
      { group: 'batch', version: 'v1', plural: 'cronjobs', kind: 'CronJob', namespaced: true },
    ],
  },
  {
    title: 'Network',
    kinds: [
      core('services', 'Service'),
      { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', kind: 'Ingress', namespaced: true },
      { group: 'networking.k8s.io', version: 'v1', plural: 'networkpolicies', kind: 'NetworkPolicy', namespaced: true },
      core('endpoints', 'Endpoints'),
    ],
  },
  {
    title: 'Config',
    kinds: [
      core('configmaps', 'ConfigMap'),
      core('secrets', 'Secret'),
      { group: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler', namespaced: true },
      core('resourcequotas', 'ResourceQuota'),
      core('limitranges', 'LimitRange'),
      { group: 'policy', version: 'v1', plural: 'poddisruptionbudgets', kind: 'PodDisruptionBudget', namespaced: true },
    ],
  },
  {
    title: 'Storage',
    kinds: [
      core('persistentvolumeclaims', 'PersistentVolumeClaim'),
      core('persistentvolumes', 'PersistentVolume', false),
      { group: 'storage.k8s.io', version: 'v1', plural: 'storageclasses', kind: 'StorageClass', namespaced: false },
    ],
  },
  {
    title: 'Access Control',
    kinds: [
      core('serviceaccounts', 'ServiceAccount'),
      { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'roles', kind: 'Role', namespaced: true },
      { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'rolebindings', kind: 'RoleBinding', namespaced: true },
      { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterroles', kind: 'ClusterRole', namespaced: false },
      { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterrolebindings', kind: 'ClusterRoleBinding', namespaced: false },
    ],
  },
];

/** Semantic column ids per kind; the client maps these to renderers. */
export const KIND_COLUMNS: Record<string, string[]> = {
  Pod: ['name', 'namespace', 'cluster', 'ready', 'podStatus', 'restarts', 'cpu', 'memory', 'node', 'age'],
  Deployment: ['name', 'namespace', 'cluster', 'workloadReady', 'upToDate', 'available', 'cpu', 'memory', 'age'],
  StatefulSet: ['name', 'namespace', 'cluster', 'workloadReady', 'cpu', 'memory', 'age'],
  DaemonSet: ['name', 'namespace', 'cluster', 'dsDesired', 'dsReady', 'cpu', 'memory', 'age'],
  ReplicaSet: ['name', 'namespace', 'cluster', 'workloadReady', 'cpu', 'memory', 'age'],
  Job: ['name', 'namespace', 'cluster', 'jobCompletions', 'jobDuration', 'age'],
  CronJob: ['name', 'namespace', 'cluster', 'cronSchedule', 'cronSuspend', 'cronLastSchedule', 'age'],
  Service: ['name', 'namespace', 'cluster', 'svcType', 'svcClusterIP', 'svcLoadBalancerIP', 'svcPorts', 'age'],
  Ingress: ['name', 'namespace', 'cluster', 'ingressClass', 'ingressHosts', 'age'],
  ConfigMap: ['name', 'namespace', 'cluster', 'dataKeys', 'age'],
  Secret: ['name', 'namespace', 'cluster', 'secretType', 'dataKeys', 'age'],
  PersistentVolumeClaim: ['name', 'namespace', 'cluster', 'pvcStatus', 'pvcCapacity', 'pvcStorageClass', 'age'],
  PersistentVolume: ['name', 'cluster', 'pvCapacity', 'pvStatus', 'pvClaim', 'age'],
  Node: [
    'name',
    'cluster',
    'nodeStatus',
    'nodePods',
    'nodeCpuUsage',
    'nodeMemoryUsage',
    'nodeCpuAllocation',
    'nodeRoles',
    'nodeVersion',
    'nodeMemoryAllocation',
    'nodeOperatingSystem',
    'nodeKernelVersion',
    'nodeContainerRuntime',
    'nodeInternalIp',
    'nodeExternalIp',
    'nodeTaints',
    'nodeConditions',
  ],
  Namespace: ['name', 'cluster', 'nsStatus', 'age'],
  Event: ['eventType', 'eventReason', 'eventObject', 'eventMessage', 'namespace', 'cluster', 'eventCount', 'eventLastSeen'],
  HorizontalPodAutoscaler: ['name', 'namespace', 'cluster', 'hpaTarget', 'hpaMinMax', 'hpaReplicas', 'age'],
  ServiceAccount: ['name', 'namespace', 'cluster', 'age'],
};

export const GENERIC_COLUMNS = ['name', 'namespace', 'cluster', 'age'];
export const GENERIC_CLUSTER_COLUMNS = ['name', 'cluster', 'age'];

export function columnsForKind(kind: string, namespaced: boolean): string[] {
  return KIND_COLUMNS[kind] ?? (namespaced ? GENERIC_COLUMNS : GENERIC_CLUSTER_COLUMNS);
}

export function pluralLabel(kind: string): string {
  if (!kind) return kind;
  if (kind === 'Endpoints') return 'Endpoints';
  if (kind === kind.toLowerCase()) return kind.charAt(0).toUpperCase() + kind.slice(1);
  if (kind.endsWith('Policy')) return `${kind.slice(0, -6)}Policies`;
  if (kind.endsWith('y')) return `${kind.slice(0, -1)}ies`;
  if (kind.endsWith('s')) return kind.endsWith('ss') ? `${kind}es` : kind;
  if (kind.endsWith('x') || kind.endsWith('ch') || kind.endsWith('sh')) return `${kind}es`;
  return `${kind}s`;
}

const GVK_BY_KIND = new Map<string, GVK>();
const GVK_BY_RESOURCE = new Map<string, GVK>();
for (const navGroup of BUILTIN_NAV_GROUPS) {
  for (const gvk of navGroup.kinds) {
    if (!GVK_BY_KIND.has(gvk.kind)) GVK_BY_KIND.set(gvk.kind, gvk);
    const key = `${gvk.group}/${gvk.version}/${gvk.plural}`;
    if (!GVK_BY_RESOURCE.has(key)) GVK_BY_RESOURCE.set(key, gvk);
  }
}

/** Look up the GVK for a builtin kind (e.g. to navigate to a related resource). */
export function gvkForKind(kind: string): GVK | undefined {
  return GVK_BY_KIND.get(kind);
}

export function gvkForResource(group: string, version: string, plural: string): GVK | undefined {
  return GVK_BY_RESOURCE.get(`${group}/${version}/${plural}`);
}

/** Sentinel used in URLs/routes for the core API group. */
export const CORE_GROUP_SENTINEL = 'core';

export function groupToPath(group: string): string {
  return group === '' ? CORE_GROUP_SENTINEL : group;
}

export function groupFromPath(pathGroup: string): string {
  return pathGroup === CORE_GROUP_SENTINEL ? '' : pathGroup;
}
