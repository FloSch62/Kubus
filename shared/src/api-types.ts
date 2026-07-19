/** REST API data transfer objects shared between server and client. */

export interface AppInfo {
  name: string;
  version: string;
  /** True when the wasm helm rendering engine is available (install/upgrade enabled). */
  helmEngine: boolean;
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
  /** Actionable problem with the user's credentials (exec plugin missing from PATH, legacy auth-provider). */
  authWarning?: string;
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
  /** Per-user credential problems in the imported entries (e.g. exec plugin not installed here). */
  warnings?: string[];
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

/** Grid state snapshotted with a saved view so restoring brings back the exact table. */
export interface SavedViewGridState {
  /** Global namespace filter at save time (empty = all namespaces). */
  namespaces?: string[];
  sort?: ReadonlyArray<{ field: string; sort: 'asc' | 'desc' | null | undefined }>;
  columnVisibility?: Record<string, boolean>;
  columnWidths?: Record<string, number>;
}

export interface SavedView {
  id: string;
  title: string;
  path: string;
  textFilter?: string;
  labelSelector?: string;
  /** Absent on views saved before grid capture existed — those restore the query only. */
  grid?: SavedViewGridState;
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
  /** Structured, operation-specific context for actionable recovery UI. */
  details?: unknown;
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
  hooksRan: string[];
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

export interface ContainerUsage {
  name: string;
  cpuMilli: number;
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
  /** Pod only: per-container usage breakdown. */
  containers?: ContainerUsage[];
}

export interface MetricsSnapshot {
  available: boolean;
  items: MetricsSnapshotEntry[];
}

export interface MetricsHistoryResponse {
  available: boolean;
  series: MetricsSample[];
}

// ---- metrics-server install / uninstall ----

export interface MetricsServerStatus {
  /** metrics-server Deployment or metrics.k8s.io APIService found in the cluster. */
  installed: boolean;
  /** The kube-system Deployment carries the Kubus managed-by label. */
  managedByKubus: boolean;
  /** Deployment reports at least one ready replica. */
  ready: boolean;
  /** Image tag of the metrics-server container, when the Deployment exists. */
  version?: string;
  /** The metrics poller is currently getting usage data. */
  metricsAvailable: boolean;
}

export interface MetricsServerInstallRequest {
  /**
   * Pass --kubelet-insecure-tls. Needed on most local/dev clusters (kind,
   * minikube, docker-desktop) whose kubelets serve self-signed certs.
   */
  insecureTls?: boolean;
}

export interface MetricsServerInstallResult {
  applied: string[];
}

export interface MetricsServerUninstallResult {
  deleted: string[];
  failed: Array<{ resource: string; error: string }>;
}

// ---- Metrics summary (Metrics page) ----

export interface MetricsSeriesEntry {
  name: string;
  namespace?: string;
  series: MetricsSample[];
  /** Nodes only: allocatable totals for utilization %. */
  cpuCapacityMilli?: number;
  memCapacityBytes?: number;
}

export interface NamespaceUsage {
  namespace: string;
  cpuMilli: number;
  memBytes: number;
  pods: number;
}

export interface ClusterMetricsSummary {
  available: boolean;
  /** Node usage summed per poll tick — the cluster-wide series. */
  clusterSeries: MetricsSample[];
  cpuCapacityMilli?: number;
  memCapacityBytes?: number;
  nodes: MetricsSeriesEntry[];
  topPodsCpu: MetricsSeriesEntry[];
  topPodsMem: MetricsSeriesEntry[];
  namespaces: NamespaceUsage[];
  podCount: number;
}

// ---- Network metrics (network agent) ----

export interface NetworkAgentStatus {
  /** The kubus-network-agent DaemonSet exists in the cluster. */
  installed: boolean;
  /** The DaemonSet carries the Kubus managed-by label. */
  managedByKubus: boolean;
  /** At least one agent pod is ready. */
  ready: boolean;
  /** Image tag of the agent container, when the DaemonSet exists. */
  version?: string;
  nodesReady: number;
  nodesDesired: number;
  /** The network poller is currently getting traffic data. */
  metricsAvailable: boolean;
}

export interface NetworkAgentInstallResult {
  applied: string[];
}

export interface NetworkAgentUninstallResult {
  deleted: string[];
  failed: Array<{ resource: string; error: string }>;
}

export interface NetworkSample {
  /** epoch millis */
  t: number;
  /** bytes per second leaving this pod */
  sentBps: number;
  /** bytes per second arriving at this pod */
  recvBps: number;
}

export interface NetworkThroughputSample {
  /** epoch millis */
  t: number;
  /** total observed bytes per second, each flow counted once */
  bps: number;
}

export interface NetworkSeriesEntry {
  name: string;
  namespace?: string;
  series: NetworkSample[];
}

export type NetworkPeerKind = 'pod' | 'service' | 'node' | 'external';

export interface NetworkPeer {
  kind: NetworkPeerKind;
  namespace?: string;
  /** Pod/service/node name, or the raw IP for external peers. */
  name: string;
}

/**
 * Observed traffic between two endpoints, direction-neutral (the agent sees
 * packets, not who connected to whom). Rates are per-second deltas between
 * the last two agent scrapes. Pod endpoints sort before non-pod ones.
 */
export interface NetworkLink {
  a: NetworkPeer;
  b: NetworkPeer;
  /** bytes per second a→b */
  abBps: number;
  /** bytes per second b→a */
  baBps: number;
  retransmitsPerSec: number;
  /** dropped bytes per second (network policy denies, conntrack, …) */
  droppedBps: number;
}

export interface ClusterNetworkSummary {
  available: boolean;
  agentsReady: number;
  agentsDesired: number;
  /** All link rates summed per poll tick — the cluster-wide series. */
  clusterSeries: NetworkThroughputSample[];
  topPodsSent: NetworkSeriesEntry[];
  topPodsRecv: NetworkSeriesEntry[];
  /** Busiest links by total rate (capped); linkCount is the uncapped total. */
  links: NetworkLink[];
  linkCount: number;
  podCount: number;
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

// ---- Security audit ----

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low';

export type AuditCategory = 'pod-security' | 'workload-resilience' | 'rbac' | 'network' | 'secrets' | 'nodes';

export interface AuditCheckInfo {
  id: string;
  title: string;
  severity: AuditSeverity;
  category: AuditCategory;
  remediation: string;
}

export interface AuditFinding {
  checkId: string;
  severity: AuditSeverity;
  category: AuditCategory;
  title: string;
  /** Instance-specific detail (which container / port / rule). */
  message: string;
  remediation: string;
  resource: ResourceRef;
}

export interface AuditReport {
  findings: AuditFinding[];
  checks: AuditCheckInfo[];
  stats: {
    resourcesScanned: number;
    checksRun: number;
    durationMs: number;
  };
  /** Lists that could not be read (RBAC denied, API unavailable, …). */
  errors: string[];
  /** True when findings were capped. */
  truncated: boolean;
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
  /** Helm storage backend the release records live in. */
  driver?: 'secret' | 'configmap';
}

export interface HelmReleaseDetail extends HelmReleaseSummary {
  notes?: string;
  /** User-supplied values (helm -f / --set). */
  values: Record<string, unknown>;
  /** chart defaults deep-merged with user values. */
  computedValues: Record<string, unknown>;
  /** Unmodified defaults embedded in this revision's chart. */
  defaultValues: Record<string, unknown>;
  /** Upstream chart homepage and source repositories stored in Chart.yaml. */
  chartHome?: string;
  chartSources: string[];
  manifest: string;
  firstDeployed?: string;
  description?: string;
  /** Number of dependencies the chart declares — values-only upgrades need a repo chart when > 0. */
  chartDependencies: number;
  /** Number of hooks stored in the release record. */
  hookCount: number;
  /** CRDs shipped in the chart's crds/ directory — offered for optional cleanup on uninstall. */
  chartCrds: string[];
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

// ---- Helm repos, install & upgrade ----

export interface HelmRepo {
  name: string;
  /** Classic http(s) chart repository base URL (serves /index.yaml). */
  url: string;
}

export interface HelmChartSummary {
  repo: string;
  name: string;
  description?: string;
  icon?: string;
  /** Latest available version. */
  version: string;
  appVersion?: string;
  deprecated?: boolean;
  keywords?: string[];
}

export interface HelmChartVersion {
  version: string;
  appVersion?: string;
  description?: string;
  created?: string;
  deprecated?: boolean;
}

/** Chart metadata + default values for the install form. */
export interface HelmChartDetail {
  name: string;
  version: string;
  appVersion?: string;
  description?: string;
  icon?: string;
  home?: string;
  sources?: string[];
  /** Parsed chart defaults. valuesYaml preserves comments for the editor. */
  values: Record<string, unknown>;
  valuesYaml: string;
  readme: string;
  dependencies?: Array<{ name: string; version: string; repository?: string }>;
}

/** Where to get a chart archive from. Exactly one source form. */
export interface HelmChartSourceRef {
  /** Configured repo name + chart + version. */
  repo?: string;
  chart?: string;
  version?: string;
  /** Repository base URL (http(s) index repo or oci:// base) + chart + version — used for Artifact Hub discoveries. */
  repoUrl?: string;
  /** Direct oci://registry/repo ref (version above selects the tag). */
  ociRef?: string;
  /** Direct .tgz URL. */
  url?: string;
}

export interface HelmInstallRequest {
  namespace: string;
  name: string;
  values: Record<string, unknown>;
  chart: HelmChartSourceRef;
  createNamespace?: boolean;
  skipHooks?: boolean;
  /** Wait for workloads to become ready before marking the revision deployed. */
  wait?: boolean;
  /** Readiness timeout; only used when wait is true. */
  timeoutSeconds?: number;
  dryRun?: boolean;
}

export interface HelmUpgradeRequest {
  /** Complete user-supplied values for the new revision (helm -f semantics). */
  values: Record<string, unknown>;
  /** Omitted → re-render the chart stored in the release record. */
  chart?: HelmChartSourceRef;
  skipHooks?: boolean;
  /** Wait for workloads to become ready before marking the revision deployed. */
  wait?: boolean;
  /** Readiness timeout; only used when wait is true. */
  timeoutSeconds?: number;
  dryRun?: boolean;
}

export interface HelmActionResult {
  revision: number;
  applied: string[];
  pruned: string[];
  failed: Array<{ resource: string; error: string }>;
  hooksRan: string[];
  notes?: string;
}

export interface HelmUninstallResult {
  deleted: string[];
  failed: Array<{ resource: string; error: string }>;
  hooksRan: string[];
  crdsDeleted: string[];
  /** True when records remain so the incomplete operation can be inspected/retried. */
  recordsRetained: boolean;
}

export interface HelmDryRunResult {
  manifest: string;
  notes: string;
  hooks: Array<{ name: string; kind: string; events: string[] }>;
  chart: string;
  chartVersion: string;
  /** Fully coalesced values for the candidate revision. */
  computedValues: Record<string, unknown>;
  /** Kubernetes API server-side dry-run findings. */
  validation: HelmResourceValidation[];
  /** Important limits of the preview validation. */
  warnings: string[];
}

export interface HelmResourceValidation {
  resource: string;
  status: 'valid' | 'warning' | 'error';
  message?: string;
}

export type HelmOperationPhase = 'pre-hook' | 'apply' | 'readiness' | 'prune' | 'post-hook' | 'record';

/** Returned in ApiErrorBody.details when a mutating Helm operation fails. */
export interface HelmOperationFailure {
  operation: 'install' | 'upgrade' | 'rollback';
  phase: HelmOperationPhase;
  revision?: number;
  /** Last revision known to have completed successfully, when one exists. */
  recoveryRevision?: number;
  applied: string[];
  pruned: string[];
  failed: Array<{ resource: string; error: string }>;
  hooksRan: string[];
  suggestions: string[];
}

export type HelmOperationKind = 'install' | 'upgrade' | 'downgrade' | 'rollback';
export type HelmOperationStatus = 'running' | 'succeeded' | 'failed';
export type HelmOperationProgressPhase =
  | 'queued'
  | 'resolving-chart'
  | 'rendering'
  | 'pre-hook'
  | 'applying'
  | 'pruning'
  | 'readiness'
  | 'post-hook'
  | 'recording'
  | 'completed';

export interface HelmOperationWaitingResource {
  resource: string;
  message: string;
}

/**
 * Live, non-secret progress for a Helm mutation. Values and rendered
 * manifests are deliberately excluded because this is broadcast to the UI.
 */
export interface HelmOperation {
  id: string;
  kind: HelmOperationKind;
  ctx: string;
  namespace: string;
  releaseName: string;
  status: HelmOperationStatus;
  phase: HelmOperationProgressPhase;
  message: string;
  startedAt: string;
  updatedAt: string;
  targetVersion?: string;
  targetRevision?: number;
  revision?: number;
  completedResources?: number;
  totalResources?: number;
  currentResource?: string;
  waitingFor?: HelmOperationWaitingResource[];
  result?: HelmActionResult | HelmRollbackResult;
  error?: string;
  failure?: HelmOperationFailure;
}

export interface HelmOperationStarted {
  operationId: string;
}

/** A chart found by exact name in a configured repo or on Artifact Hub (upgrade-source discovery). */
export interface HelmChartHit {
  repo: string;
  versions: HelmChartVersion[];
  /** Set for Artifact Hub discoveries: the publisher's repository URL (http(s) or oci://). */
  repoUrl?: string;
  fromHub?: boolean;
}

/** An Artifact Hub search result. */
export interface HelmHubChart {
  name: string;
  repoName: string;
  repoUrl: string;
  description?: string;
  icon?: string;
  version: string;
  appVersion?: string;
  official?: boolean;
  verifiedPublisher?: boolean;
}

export interface HelmUpdateCheck {
  /** Caller-stable release identity; echoed by the response. */
  id: string;
  chart: string;
  currentVersion: string;
  /** Narrows same-name/same-version source collisions when metadata provides it. */
  currentAppVersion?: string;
}

export interface HelmChartUpdate {
  id: string;
  chart: string;
  currentVersion: string;
  currentAppVersion?: string;
  available: boolean;
  latestVersion?: string;
  latestAppVersion?: string;
  repo?: string;
  repoUrl?: string;
  /** Why no safe update could be selected. */
  reason?: 'up-to-date' | 'chart-not-found' | 'current-version-not-found';
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
