/** REST API data transfer objects shared between server and client. */

export interface AppInfo {
  name: string;
  version: string;
}

export type UpdateCheckResult =
  | {
      available: true;
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      releaseUrl: string;
      publishedAt?: string;
    }
  | {
      available: false;
      currentVersion: string;
      latestVersion?: string;
      reason?: string;
    };

export type ContextHealth = 'connected' | 'connecting' | 'error' | 'unknown';

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  server?: string;
  /** Whether this is kubeconfig's current context. */
  current?: boolean;
  health: ContextHealth;
  healthMessage?: string;
  /** Whether the server currently holds an active handle (watchers, pollers). */
  active: boolean;
  kubernetesVersion?: string;
  /** Effective `proxy-url` for this context's cluster, if any (kubeconfig or env-injected). */
  proxyUrl?: string;
  /** Whether proxyUrl came from an env var (HTTPS_PROXY/ALL_PROXY) rather than the kubeconfig file. */
  proxyFromEnv?: boolean;
  /** SSH jump host whose Kubus-managed tunnel carries this cluster's traffic. */
  sshHost?: string;
  /** `tls-server-name` override for this context's cluster, if any. */
  tlsServerName?: string;
  /** Whether the cluster has `insecure-skip-tls-verify` set. */
  skipTlsVerify?: boolean;
  /** Whether the cluster has a custom CA certificate configured. */
  caPresent?: boolean;
  /** How the context's user authenticates (informational, for the editor). */
  authType?: ClusterAuthType;
}

export type ClusterAuthType = 'token' | 'client-cert' | 'exec' | 'auth-provider' | 'basic' | 'none';

// ---- Settings / kubeconfig management ----

export type KubeconfigSource = 'cli-flag' | 'settings-file' | 'env' | 'default';

export interface KubeconfigSettings {
  /** All files currently being read/watched, in precedence order. */
  paths: string[];
  /** The file imports are written to (paths[0]); null if none resolvable. */
  primaryPath: string | null;
  /** Active explicit override, if any. */
  override: string | null;
  /** Where the effective kubeconfig came from. */
  source: KubeconfigSource;
  /** $KUBECONFIG as seen by the server (informational). */
  kubeconfigEnv: string | null;
}

/** A full edit of an existing context's cluster + user, mirroring "Add cluster". */
export interface EditClusterRequest {
  /** API server URL. */
  server: string;
  /** Skip TLS certificate verification (insecure). */
  skipTlsVerify: boolean;
  /** New CA certificate PEM; null/empty keeps the current one. */
  caPem: string | null;
  /** Proxy URL (socks5://, http://, https://); null/empty clears it. */
  proxyUrl: string | null;
  /**
   * SSH jump host for a Kubus-managed tunnel (an ssh_config Host alias or
   * `user@host`). Stored in Kubus settings — not the kubeconfig — so the file
   * stays kubectl-compatible. null/empty clears it. Mutually exclusive with proxyUrl.
   */
  sshHost?: string | null;
  /** TLS server name override (SNI/cert hostname); null/empty clears it. */
  tlsServerName: string | null;
  /** How to set credentials. `keep` preserves the existing user (incl. exec/auth-provider auth). */
  auth:
    | { method: 'keep' }
    | { method: 'token'; token: string }
    | { method: 'client-cert'; clientCertPem: string; clientKeyPem: string };
}

// ---- SSH jump hosts ----

/** One usable `Host` entry from the user's ssh config (wildcard patterns are skipped). */
export interface SshConfigHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
}

export interface SshInfoResponse {
  /** Whether an OpenSSH client binary was found on the machine running Kubus. */
  sshAvailable: boolean;
  /** e.g. "OpenSSH_9.6p1" when available. */
  sshVersion?: string;
  /** Platform the Kubus server runs on — drives OS-specific help in the UI. */
  platform: string;
  /** Resolved path of the user's ssh config (~/.ssh/config). */
  configPath: string;
  configExists: boolean;
  hosts: SshConfigHost[];
  /** Non-fatal problem while reading the config (hosts may be incomplete). */
  parseError?: string;
}

/** Set/clear a context's Kubus-managed SSH jump host without touching other cluster fields. */
export interface SetSshHostRequest {
  /** ssh_config Host alias, user@host or ssh://user@host:port; null clears the tunnel. */
  sshHost: string | null;
}

export interface TestConnectionResponse {
  health: 'connected' | 'error';
  healthMessage?: string;
  kubernetesVersion?: string;
}

export interface SetKubeconfigRequest {
  /** Absolute or ~-prefixed path; null clears the override (back to env/default). */
  path: string | null;
}

export interface KubeconfigImportRequest {
  yaml: string;
  /** Replace existing entries with the same name instead of failing with 409. */
  overwrite?: boolean;
}

export interface KubeconfigImportResponse {
  added: { contexts: string[]; clusters: string[]; users: string[] };
  /** Entries identical to existing ones, silently skipped. */
  skipped: string[];
  /** Backup written before the merge; null when the target file didn't exist. */
  backupPath: string | null;
  /** Fresh context list after the reload. */
  contexts: ContextInfo[];
}

export interface ResourceKindInfo {
  group: string; // '' for core
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  verbs: string[];
  shortNames?: string[];
  categories?: string[];
  /** True if this kind comes from a CRD rather than a builtin API group. */
  custom?: boolean;
}

export interface KubeObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller?: boolean;
  }>;
  deletionTimestamp?: string;
}

/** Loosely-typed Kubernetes object — the UI reads what it needs per kind. */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: KubeObjectMeta;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ListResponse {
  items: KubeObject[];
  resourceVersion?: string;
  continue?: string;
}

export interface ResourceRef {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
}

// ---- Search / saved navigation ----

export type SearchResultKind = 'resource' | 'kind' | 'page';

export interface SearchResult {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle?: string;
  score: number;
  ref?: ResourceRef;
  path?: string;
}

export interface FavoriteItem {
  id: string;
  title: string;
  subtitle?: string;
  path?: string;
  ref?: ResourceRef;
}

export interface SavedView {
  id: string;
  title: string;
  path: string;
  textFilter?: string;
  labelSelector?: string;
  fieldSelector?: string;
}

// ---- Topology graph ----

export type GraphNodeStatus = 'success' | 'warning' | 'error' | 'unknown';

export interface GraphNode {
  id: string;
  ref: ResourceRef;
  label: string;
  sublabel?: string;
  layer: 'entry' | 'route' | 'service' | 'workload' | 'replicaset' | 'pod' | 'storage' | 'node' | 'operator' | 'other';
  status: GraphNodeStatus;
  reason?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: 'owns' | 'selects' | 'routes' | 'mounts' | 'binds' | 'schedules' | 'manages';
}

export interface RelationshipGraph {
  ctx: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

// ---- Validation / dry-run ----

export interface ValidationFinding {
  severity: 'info' | 'warning' | 'error';
  message: string;
  field?: string;
  reason?: string;
}

export interface ResourceDryRunResponse {
  ok: boolean;
  ref?: ResourceRef;
  findings: ValidationFinding[];
}

export interface ApiErrorBody {
  message: string;
  reason?: string;
  code?: number;
  k8sStatus?: unknown;
}

// ---- Actions ----

export interface ScaleRequest {
  group: string;
  version: string;
  plural: string;
  namespace: string;
  name: string;
  replicas: number;
}

export interface RolloutRestartRequest {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'ReplicaSet';
  namespace: string;
  name: string;
}

export interface SuspendCronJobRequest {
  namespace: string;
  name: string;
  suspend: boolean;
}

export interface SetImageRequest {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  namespace: string;
  name: string;
  container: string;
  image: string;
  initContainer?: boolean;
}

export interface CordonRequest {
  node: string;
  unschedulable: boolean;
}

export interface DrainRequest {
  node: string;
  gracePeriodSeconds?: number;
  /** Delete pods using emptyDir data. */
  force?: boolean;
}

export interface DrainStartedResponse {
  drainId: string;
  totalPods: number;
}

export interface TriggerCronJobRequest {
  namespace: string;
  name: string;
}

export interface RerunJobRequest {
  namespace: string;
  name: string;
}

export interface RolloutUndoRequest {
  kind: 'Deployment' | 'StatefulSet';
  namespace: string;
  name: string;
  /** Omitted: roll back to the latest non-current revision. */
  toRevision?: number;
}

export interface RolloutPauseRequest {
  namespace: string;
  name: string;
  paused: boolean;
}

/** One entry of a workload's rollout history (ReplicaSet / ControllerRevision). */
export interface RolloutRevision {
  revision: number;
  /** Name of the backing ReplicaSet / ControllerRevision. */
  name: string;
  createdAt?: string;
  images: string[];
  changeCause?: string;
  current: boolean;
  replicas?: number;
}

export interface DebugPodRequest {
  namespace: string;
  pod: string;
  /** Debug container image; defaults to busybox. */
  image?: string;
  /** Container whose process namespace the debug container targets. */
  target?: string;
}

export interface DebugPodResponse {
  containerName: string;
}

export interface StopDebugRequest {
  namespace: string;
  pod: string;
  container: string;
}

export interface HelmRollbackResult {
  newRevision: number;
  applied: string[];
  pruned: string[];
  failed: Array<{ resource: string; error: string }>;
}

/** A CRD additionalPrinterColumns entry (apiextensions.k8s.io/v1). */
export interface PrinterColumn {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date';
  jsonPath: string;
  priority?: number;
  description?: string;
}

// ---- Detail views ----

export interface PodEnvVar {
  name: string;
  value?: string;
  source?: {
    type: 'literal' | 'configMapKeyRef' | 'secretKeyRef' | 'fieldRef' | 'resourceFieldRef' | 'configMapRef' | 'secretRef';
    ref?: string;
    key?: string;
  };
  /** Value comes from a Secret and is hidden unless requested with reveal. */
  redacted?: boolean;
  error?: string;
}

export interface PodEnvResponse {
  containers: Array<{ name: string; init?: boolean; env: PodEnvVar[] }>;
}

export interface TlsCertInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sans: string[];
  isCA: boolean;
  selfSigned: boolean;
}

export interface SecretTlsResponse {
  certificates: TlsCertInfo[];
}

// ---- Logs ----

export type LogTargetKind = 'Pod' | 'Deployment' | 'ReplicaSet' | 'StatefulSet' | 'DaemonSet' | 'Service';

export interface LogTargetPod {
  name: string;
  namespace: string;
  containers: string[];
}

export interface LogTargetPodsResponse {
  pods: LogTargetPod[];
}

// ---- Metrics ----

export interface MetricsSample {
  /** epoch millis */
  t: number;
  /** CPU in millicores */
  cpuMilli: number;
  /** memory in bytes */
  memBytes: number;
}

export interface MetricsSnapshotEntry {
  name: string;
  namespace?: string;
  cpuMilli: number;
  memBytes: number;
  /** Node only: allocatable totals for utilization %. */
  cpuCapacityMilli?: number;
  memCapacityBytes?: number;
}

export interface MetricsSnapshot {
  available: boolean;
  items: MetricsSnapshotEntry[];
}

export interface MetricsHistoryResponse {
  available: boolean;
  series: MetricsSample[];
}

// ---- Overview ----

export interface OverviewProblemPod {
  namespace: string;
  name: string;
  reason: string;
  message?: string;
  restarts: number;
}

export interface OverviewWorkloadIssue {
  kind: string;
  namespace: string;
  name: string;
  ready: number;
  desired: number;
}

export interface OverviewWarningEvent {
  namespace: string;
  reason: string;
  message: string;
  involvedKind: string;
  involvedName: string;
  count: number;
  lastTimestamp?: string;
}

export interface OverviewRestart {
  namespace: string;
  pod: string;
  container: string;
  restarts: number;
  finishedAt?: string;
  reason?: string;
}

export interface ClusterOverview {
  counts: {
    nodes: number;
    namespaces: number;
    pods: number;
    podsRunning: number;
    deployments: number;
    persistentVolumes: number;
    persistentVolumesBound: number;
    persistentVolumesUnavailable: boolean;
    crds: number;
    crdsEstablished: number;
    crdsUnavailable: boolean;
    customResources: number;
    customResourcesIndexed: boolean;
  };
  failingPods: OverviewProblemPod[];
  unavailableWorkloads: OverviewWorkloadIssue[];
  recentRestarts: OverviewRestart[];
  warningEvents: OverviewWarningEvent[];
}

// ---- Helm ----

export interface HelmReleaseSummary {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chartVersion: string;
  appVersion?: string;
  updated?: string;
}

export interface HelmReleaseDetail extends HelmReleaseSummary {
  notes?: string;
  /** User-supplied values (helm -f / --set). */
  values: Record<string, unknown>;
  /** chart defaults deep-merged with user values. */
  computedValues: Record<string, unknown>;
  manifest: string;
  firstDeployed?: string;
  description?: string;
}

export interface HelmRevision {
  revision: number;
  status: string;
  chart: string;
  chartVersion: string;
  appVersion?: string;
  updated?: string;
  description?: string;
}

// ---- Port forward ----

export interface PortForwardInfo {
  id: string;
  ctx: string;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  /** Pod actually being forwarded to (resolved for services). */
  targetPod?: string;
  remotePort: number;
  localPort: number;
  state: 'active' | 'error';
  error?: string;
  connections: number;
}

export interface PortForwardRequest {
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  remotePort: number;
  localPort?: number;
}
