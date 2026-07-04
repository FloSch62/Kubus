/**
 * Security audit: built-in checks over workloads, RBAC, network and nodes.
 * One-shot listing via the raw client — results are computed on demand and
 * degrade gracefully (a denied list becomes a report error, not a failure).
 */
import type { AuditCategory, AuditCheckInfo, AuditFinding, AuditReport, AuditSeverity, KubeObject, ResourceRef } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';

const MAX_FINDINGS = 2000;

interface KindSpec {
  group: string;
  version: string;
  plural: string;
  kind: string;
}

const KINDS = {
  pods: { group: '', version: 'v1', plural: 'pods', kind: 'Pod' },
  deployments: { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment' },
  statefulsets: { group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet' },
  daemonsets: { group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet' },
  jobs: { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job' },
  cronjobs: { group: 'batch', version: 'v1', plural: 'cronjobs', kind: 'CronJob' },
  services: { group: '', version: 'v1', plural: 'services', kind: 'Service' },
  ingresses: { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', kind: 'Ingress' },
  networkpolicies: { group: 'networking.k8s.io', version: 'v1', plural: 'networkpolicies', kind: 'NetworkPolicy' },
  poddisruptionbudgets: { group: 'policy', version: 'v1', plural: 'poddisruptionbudgets', kind: 'PodDisruptionBudget' },
  namespaces: { group: '', version: 'v1', plural: 'namespaces', kind: 'Namespace' },
  nodes: { group: '', version: 'v1', plural: 'nodes', kind: 'Node' },
  clusterroles: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterroles', kind: 'ClusterRole' },
  clusterrolebindings: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'clusterrolebindings', kind: 'ClusterRoleBinding' },
  roles: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'roles', kind: 'Role' },
  rolebindings: { group: 'rbac.authorization.k8s.io', version: 'v1', plural: 'rolebindings', kind: 'RoleBinding' },
  configmaps: { group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap' },
  serviceaccounts: { group: '', version: 'v1', plural: 'serviceaccounts', kind: 'ServiceAccount' },
} satisfies Record<string, KindSpec>;

type Lists = Record<keyof typeof KINDS, KubeObject[]>;

// ---- check registry ----

function check(id: string, title: string, severity: AuditSeverity, category: AuditCategory, remediation: string): AuditCheckInfo {
  return { id, title, severity, category, remediation };
}

export const AUDIT_CHECKS: AuditCheckInfo[] = [
  check('privileged-container', 'Privileged container', 'critical', 'pod-security', 'Remove securityContext.privileged or isolate the workload; privileged containers own the node.'),
  check('docker-socket-mount', 'Container runtime socket mounted', 'critical', 'pod-security', 'Do not mount the container runtime socket; use a purpose-built API or rootless alternative.'),
  check('host-network', 'Pod uses the host network', 'high', 'pod-security', 'Drop spec.hostNetwork; expose ports through Services instead.'),
  check('host-pid-ipc', 'Pod shares host PID/IPC namespace', 'high', 'pod-security', 'Drop hostPID/hostIPC unless the workload genuinely inspects host processes.'),
  check('hostpath-volume', 'hostPath volume', 'high', 'pod-security', 'Replace hostPath with a PersistentVolumeClaim, ConfigMap, or projected volume.'),
  check('dangerous-capabilities', 'Dangerous Linux capability added', 'high', 'pod-security', 'Remove SYS_ADMIN/NET_ADMIN-class capabilities; grant the narrowest capability that works.'),
  check('secret-env-value', 'Secret-looking literal in env var', 'high', 'secrets', 'Move the value into a Secret and reference it with valueFrom.secretKeyRef.'),
  check('privilege-escalation', 'Privilege escalation allowed', 'medium', 'pod-security', 'Set securityContext.allowPrivilegeEscalation: false on every container.'),
  check('run-as-root', 'Container may run as root', 'medium', 'pod-security', 'Set runAsNonRoot: true (and a non-zero runAsUser) at pod or container level.'),
  check('host-port', 'Container binds a host port', 'medium', 'pod-security', 'Prefer Services/Ingress over hostPort; hostPort pins pods and opens node ports.'),
  check('added-capabilities', 'Extra Linux capabilities added', 'medium', 'pod-security', 'Drop added capabilities unless required; document the ones that remain.'),
  check('missing-limits', 'Missing CPU/memory limits', 'medium', 'pod-security', 'Set resources.limits so one workload cannot starve the node.'),
  check('latest-tag', 'Mutable image tag', 'medium', 'pod-security', 'Pin images to a version or digest; :latest deploys are unreproducible.'),
  check('seccomp-unconfined', 'Seccomp disabled', 'medium', 'pod-security', 'Remove seccompProfile.type: Unconfined; use RuntimeDefault.'),
  check('apparmor-unconfined', 'AppArmor disabled', 'medium', 'pod-security', 'Remove the unconfined AppArmor annotation; use runtime/default.'),
  check('default-service-account', 'Default ServiceAccount token mounted', 'medium', 'pod-security', 'Use a dedicated ServiceAccount, or set automountServiceAccountToken: false.'),
  check('configmap-secretlike', 'Secret-looking data in ConfigMap', 'medium', 'secrets', 'Move credentials from ConfigMaps into Secrets (and consider encryption at rest).'),
  check('ingress-no-tls', 'Ingress without TLS', 'medium', 'network', 'Add spec.tls with a certificate for every exposed host.'),
  check('no-drop-capabilities', 'Capabilities not dropped', 'low', 'pod-security', 'Add capabilities.drop: ["ALL"] and re-add only what is needed.'),
  check('writable-root-fs', 'Writable root filesystem', 'low', 'pod-security', 'Set readOnlyRootFilesystem: true and mount emptyDir volumes where writes are needed.'),
  check('missing-requests', 'Missing CPU/memory requests', 'low', 'pod-security', 'Set resources.requests so the scheduler can place pods sensibly.'),
  check('missing-liveness', 'No liveness probe', 'low', 'workload-resilience', 'Add a livenessProbe so wedged containers restart automatically.'),
  check('missing-readiness', 'No readiness probe', 'low', 'workload-resilience', 'Add a readinessProbe so traffic only reaches pods that can serve.'),
  check('single-replica', 'Single replica', 'low', 'workload-resilience', 'Run at least 2 replicas for anything that should survive a node drain.'),
  check('no-pdb', 'No PodDisruptionBudget', 'low', 'workload-resilience', 'Add a PodDisruptionBudget so voluntary disruptions keep quorum.'),
  check('wildcard-rbac', 'Wildcard RBAC rule', 'high', 'rbac', 'Replace *(apiGroups/resources/verbs) rules with explicit grants.'),
  check('cluster-admin-binding', 'cluster-admin binding', 'high', 'rbac', 'Bind a narrower role; cluster-admin for workloads or humans is rarely justified.'),
  check('rbac-escalation-verbs', 'RBAC escalation verbs', 'high', 'rbac', 'Remove escalate/bind/impersonate verbs unless this subject manages RBAC itself.'),
  check('secrets-read-access', 'Broad secrets read access', 'medium', 'rbac', 'Scope secret access to named resources or move to a narrower namespace role.'),
  check('nodeport-service', 'NodePort service', 'low', 'network', 'Prefer LoadBalancer/Ingress; NodePort exposes every node on that port.'),
  check('no-network-policy', 'Namespace without NetworkPolicy', 'low', 'network', 'Add a default-deny NetworkPolicy and allow required flows explicitly.'),
  check('node-not-ready', 'Node not ready', 'high', 'nodes', 'Investigate kubelet/network on the node; workloads may be unschedulable.'),
];

const CHECK_BY_ID = new Map(AUDIT_CHECKS.map((c) => [c.id, c]));

// ---- pod spec plumbing ----

interface Container {
  name: string;
  image?: string;
  ports?: Array<{ hostPort?: number; containerPort?: number }>;
  env?: Array<{ name: string; value?: string }>;
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  livenessProbe?: unknown;
  readinessProbe?: unknown;
  securityContext?: {
    privileged?: boolean;
    allowPrivilegeEscalation?: boolean;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { add?: string[]; drop?: string[] };
    seccompProfile?: { type?: string };
  };
}

interface PodSpec {
  containers?: Container[];
  initContainers?: Container[];
  volumes?: Array<{ name: string; hostPath?: { path?: string } }>;
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; seccompProfile?: { type?: string } };
}

/** A workload (or bare pod) whose pod template gets the pod-level checks. */
interface PodSource {
  ref: ResourceRef;
  spec: PodSpec;
  /** Pod template annotations (AppArmor lives there). */
  annotations: Record<string, string>;
  templateLabels: Record<string, string>;
  kind: string;
  replicas?: number;
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

function podSources(ctx: string, lists: Lists): PodSource[] {
  const out: PodSource[] = [];
  const template = (obj: KubeObject): { spec?: PodSpec; metadata?: { annotations?: Record<string, string>; labels?: Record<string, string> } } | undefined =>
    (obj.spec as { template?: { spec?: PodSpec; metadata?: { annotations?: Record<string, string>; labels?: Record<string, string> } } } | undefined)?.template;

  for (const key of ['deployments', 'statefulsets', 'daemonsets', 'jobs'] as const) {
    for (const obj of lists[key]) {
      // CronJob-owned Jobs are audited through their CronJob template.
      if (key === 'jobs' && (obj.metadata.ownerReferences ?? []).some((o) => o.kind === 'CronJob')) continue;
      const t = template(obj);
      if (!t?.spec) continue;
      out.push({
        ref: ref(ctx, KINDS[key], obj),
        spec: t.spec,
        annotations: t.metadata?.annotations ?? {},
        templateLabels: t.metadata?.labels ?? {},
        kind: KINDS[key].kind,
        replicas: (obj.spec as { replicas?: number } | undefined)?.replicas,
      });
    }
  }
  for (const obj of lists.cronjobs) {
    const t = (obj.spec as { jobTemplate?: { spec?: { template?: { spec?: PodSpec; metadata?: { annotations?: Record<string, string>; labels?: Record<string, string> } } } } } | undefined)
      ?.jobTemplate?.spec?.template;
    if (!t?.spec) continue;
    out.push({
      ref: ref(ctx, KINDS.cronjobs, obj),
      spec: t.spec,
      annotations: t.metadata?.annotations ?? {},
      templateLabels: t.metadata?.labels ?? {},
      kind: 'CronJob',
    });
  }
  for (const obj of lists.pods) {
    // Controller-owned pods are audited through their controller.
    if ((obj.metadata.ownerReferences ?? []).length) continue;
    out.push({
      ref: ref(ctx, KINDS.pods, obj),
      spec: (obj.spec ?? {}) as PodSpec,
      annotations: obj.metadata.annotations ?? {},
      templateLabels: obj.metadata.labels ?? {},
      kind: 'Pod',
    });
  }
  return out;
}

function allContainers(spec: PodSpec): Container[] {
  return [...(spec.containers ?? []), ...(spec.initContainers ?? [])];
}

// ---- individual checks ----

const DANGEROUS_CAPS = new Set(['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_READ_SEARCH', 'DAC_OVERRIDE', 'CAP_SYS_ADMIN', 'CAP_NET_ADMIN', 'BPF', 'SYS_BOOT', 'SYS_RAWIO']);
const SECRET_NAME_RE = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;
const RUNTIME_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock', '/var/run/crio/crio.sock'];
const PROBE_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Pod']);

type Emit = (checkId: string, resource: ResourceRef, message: string) => void;

function auditPodSource(source: PodSource, emit: Emit): void {
  const { spec, ref: res } = source;
  const containers = allContainers(spec);
  const byCheck = new Map<string, string[]>();
  const add = (checkId: string, message: string) => {
    byCheck.set(checkId, [...(byCheck.get(checkId) ?? []), message]);
  };

  if (spec.hostNetwork) add('host-network', 'spec.hostNetwork is true');
  if (spec.hostPID || spec.hostIPC) {
    add('host-pid-ipc', [spec.hostPID ? 'hostPID' : '', spec.hostIPC ? 'hostIPC' : ''].filter(Boolean).join(' and ') + ' enabled');
  }
  for (const volume of spec.volumes ?? []) {
    const path = volume.hostPath?.path;
    if (!path) continue;
    if (RUNTIME_SOCKETS.some((sock) => path.startsWith(sock))) add('docker-socket-mount', `volume "${volume.name}" mounts ${path}`);
    else add('hostpath-volume', `volume "${volume.name}" mounts host path ${path}`);
  }
  if (spec.securityContext?.seccompProfile?.type === 'Unconfined') add('seccomp-unconfined', 'pod seccompProfile is Unconfined');
  for (const [key, value] of Object.entries(source.annotations)) {
    if (key.startsWith('container.apparmor.security.beta.kubernetes.io/') && value === 'unconfined') {
      add('apparmor-unconfined', `${key.split('/')[1]} runs unconfined`);
    }
  }
  if ((spec.serviceAccountName ?? 'default') === 'default' && spec.automountServiceAccountToken !== false) {
    add('default-service-account', 'uses the default ServiceAccount with token automount');
  }

  const podNonRoot = spec.securityContext?.runAsNonRoot === true || (spec.securityContext?.runAsUser ?? 0) > 0;
  for (const c of containers) {
    const sc = c.securityContext ?? {};
    if (sc.privileged) add('privileged-container', `container "${c.name}"`);
    else if (sc.allowPrivilegeEscalation !== false) add('privilege-escalation', `container "${c.name}"`);
    if (!podNonRoot && !(sc.runAsNonRoot === true || (sc.runAsUser ?? 0) > 0)) add('run-as-root', `container "${c.name}"`);
    if (sc.readOnlyRootFilesystem !== true) add('writable-root-fs', `container "${c.name}"`);
    if (sc.seccompProfile?.type === 'Unconfined') add('seccomp-unconfined', `container "${c.name}"`);

    const added = sc.capabilities?.add ?? [];
    const dangerous = added.filter((cap) => DANGEROUS_CAPS.has(cap.toUpperCase()));
    if (dangerous.length) add('dangerous-capabilities', `container "${c.name}" adds ${dangerous.join(', ')}`);
    else if (added.length) add('added-capabilities', `container "${c.name}" adds ${added.join(', ')}`);
    if (!(sc.capabilities?.drop ?? []).some((cap) => cap.toUpperCase() === 'ALL')) add('no-drop-capabilities', `container "${c.name}"`);

    for (const port of c.ports ?? []) {
      if (port.hostPort) add('host-port', `container "${c.name}" binds host port ${port.hostPort}`);
    }
    const image = c.image ?? '';
    const tagless = !image.includes('@') && !/:[\w][\w.-]*$/.test(image.slice(image.lastIndexOf('/') + 1)) ;
    if (image.endsWith(':latest') || (image && tagless)) add('latest-tag', `container "${c.name}" uses ${image || 'an untagged image'}`);

    const limits = c.resources?.limits ?? {};
    const requests = c.resources?.requests ?? {};
    const missingLimits = ['cpu', 'memory'].filter((r) => !limits[r]);
    const missingRequests = ['cpu', 'memory'].filter((r) => !requests[r]);
    if (missingLimits.length) add('missing-limits', `container "${c.name}" has no ${missingLimits.join('/')} limit`);
    if (missingRequests.length) add('missing-requests', `container "${c.name}" has no ${missingRequests.join('/')} request`);

    for (const env of c.env ?? []) {
      if (env.value && SECRET_NAME_RE.test(env.name)) add('secret-env-value', `container "${c.name}" env ${env.name} holds a literal value`);
    }
  }

  if (PROBE_KINDS.has(source.kind)) {
    for (const c of spec.containers ?? []) {
      if (!c.livenessProbe) add('missing-liveness', `container "${c.name}"`);
      if (!c.readinessProbe) add('missing-readiness', `container "${c.name}"`);
    }
  }

  if ((source.kind === 'Deployment' || source.kind === 'StatefulSet') && source.replicas === 1) {
    add('single-replica', 'spec.replicas is 1');
  }

  for (const [checkId, messages] of byCheck) {
    emit(checkId, res, messages.slice(0, 5).join('; ') + (messages.length > 5 ? ` (+${messages.length - 5} more)` : ''));
  }
}

interface RbacRule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}

function auditRbac(ctx: string, lists: Lists, emit: Emit): void {
  const roleKinds = [
    { key: 'clusterroles' as const, spec: KINDS.clusterroles },
    { key: 'roles' as const, spec: KINDS.roles },
  ];
  for (const { key, spec } of roleKinds) {
    for (const obj of lists[key]) {
      if (obj.metadata.name.startsWith('system:')) continue;
      const rules = ((obj as { rules?: RbacRule[] }).rules ?? []) as RbacRule[];
      for (const rule of rules) {
        const verbs = rule.verbs ?? [];
        const resources = rule.resources ?? [];
        if (verbs.includes('*') && resources.includes('*') && (rule.apiGroups ?? []).includes('*')) {
          emit('wildcard-rbac', ref(ctx, spec, obj), 'grants * verbs on * resources in * API groups');
          break;
        }
      }
      const escalation = rules.some((r) => (r.verbs ?? []).some((v) => ['escalate', 'bind', 'impersonate'].includes(v)));
      if (escalation) emit('rbac-escalation-verbs', ref(ctx, spec, obj), 'rules include escalate/bind/impersonate');
      const secretsRead = rules.some(
        (r) =>
          (r.resources ?? []).includes('secrets') &&
          (r.verbs ?? []).some((v) => ['get', 'list', 'watch', '*'].includes(v)) &&
          !(r as { resourceNames?: string[] }).resourceNames?.length,
      );
      if (secretsRead) emit('secrets-read-access', ref(ctx, spec, obj), 'can read all secrets it can see');
    }
  }

  const bindingKinds = [
    { key: 'clusterrolebindings' as const, spec: KINDS.clusterrolebindings },
    { key: 'rolebindings' as const, spec: KINDS.rolebindings },
  ];
  for (const { key, spec } of bindingKinds) {
    for (const obj of lists[key]) {
      if (obj.metadata.name.startsWith('system:')) continue;
      const roleRef = (obj as { roleRef?: { name?: string; kind?: string } }).roleRef;
      if (roleRef?.name !== 'cluster-admin') continue;
      const subjects = ((obj as { subjects?: Array<{ kind?: string; name?: string; namespace?: string }> }).subjects ?? [])
        .map((s) => `${s.kind}/${s.namespace ? `${s.namespace}/` : ''}${s.name}`)
        .join(', ');
      emit('cluster-admin-binding', ref(ctx, spec, obj), subjects ? `binds cluster-admin to ${subjects}` : 'binds cluster-admin');
    }
  }
}

function auditNetwork(ctx: string, lists: Lists, emit: Emit): void {
  for (const svc of lists.services) {
    if ((svc.spec as { type?: string } | undefined)?.type === 'NodePort') {
      const ports = ((svc.spec as { ports?: Array<{ nodePort?: number }> }).ports ?? [])
        .map((p) => p.nodePort)
        .filter(Boolean)
        .join(', ');
      emit('nodeport-service', ref(ctx, KINDS.services, svc), ports ? `exposes node port(s) ${ports}` : 'exposes a node port');
    }
  }

  for (const ing of lists.ingresses) {
    const spec = ing.spec as { tls?: Array<{ hosts?: string[] }>; rules?: Array<{ host?: string }> } | undefined;
    const tlsHosts = new Set((spec?.tls ?? []).flatMap((t) => t.hosts ?? []));
    const plain = (spec?.rules ?? []).map((r) => r.host ?? '*').filter((h) => !tlsHosts.has(h));
    if (!spec?.tls?.length || plain.length) {
      emit('ingress-no-tls', ref(ctx, KINDS.ingresses, ing), spec?.tls?.length ? `hosts without TLS: ${plain.join(', ')}` : 'no spec.tls configured');
    }
  }

  const podsByNs = new Set(lists.pods.map((p) => p.metadata.namespace ?? ''));
  const netpolNs = new Set(lists.networkpolicies.map((np) => np.metadata.namespace ?? ''));
  for (const ns of lists.namespaces) {
    const name = ns.metadata.name;
    if (name.startsWith('kube-')) continue;
    if (podsByNs.has(name) && !netpolNs.has(name)) {
      emit('no-network-policy', ref(ctx, KINDS.namespaces, ns), 'namespace runs pods but defines no NetworkPolicy');
    }
  }
}

function auditPdb(ctx: string, sources: PodSource[], lists: Lists, emit: Emit): void {
  interface PdbSelector {
    namespace: string;
    matchLabels: Record<string, string>;
    hasExpressions: boolean;
  }
  const pdbs: PdbSelector[] = lists.poddisruptionbudgets.map((pdb) => {
    const selector = (pdb.spec as { selector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] } } | undefined)?.selector;
    return {
      namespace: pdb.metadata.namespace ?? '',
      matchLabels: selector?.matchLabels ?? {},
      hasExpressions: !!selector?.matchExpressions?.length,
    };
  });
  for (const source of sources) {
    if (source.kind !== 'Deployment' && source.kind !== 'StatefulSet') continue;
    if ((source.replicas ?? 1) < 2) continue;
    const covered = pdbs.some((pdb) => {
      if (pdb.namespace !== (source.ref.namespace ?? '')) return false;
      if (pdb.hasExpressions) return true; // conservatively assume it matches
      const entries = Object.entries(pdb.matchLabels);
      return entries.length > 0 && entries.every(([k, v]) => source.templateLabels[k] === v);
    });
    if (!covered) emit('no-pdb', source.ref, `${source.replicas} replicas but no matching PodDisruptionBudget`);
  }
}

function auditConfigMaps(ctx: string, lists: Lists, emit: Emit): void {
  for (const cm of lists.configmaps) {
    const data = (cm.data ?? {}) as Record<string, unknown>;
    const suspicious = Object.entries(data)
      .filter(([key, value]) => SECRET_NAME_RE.test(key) && typeof value === 'string' && value.length > 0 && !value.startsWith('/'))
      .map(([key]) => key);
    if (suspicious.length) {
      emit('configmap-secretlike', ref(ctx, KINDS.configmaps, cm), `keys look like credentials: ${suspicious.slice(0, 5).join(', ')}`);
    }
  }
}

function auditNodes(ctx: string, lists: Lists, emit: Emit): void {
  for (const node of lists.nodes) {
    const conditions = (node.status as { conditions?: Array<{ type?: string; status?: string; message?: string }> } | undefined)?.conditions ?? [];
    const ready = conditions.find((c) => c.type === 'Ready');
    if (ready && ready.status !== 'True') {
      emit('node-not-ready', ref(ctx, KINDS.nodes, node), ready.message ?? `Ready condition is ${ready.status}`);
    }
  }
}

/** Resolve default-SA automount at the ServiceAccount level to cut noise. */
function pruneDefaultSaFindings(findings: AuditFinding[], lists: Lists): AuditFinding[] {
  const optedOut = new Set(
    lists.serviceaccounts
      .filter((sa) => sa.metadata.name === 'default' && (sa as { automountServiceAccountToken?: boolean }).automountServiceAccountToken === false)
      .map((sa) => sa.metadata.namespace ?? ''),
  );
  if (!optedOut.size) return findings;
  return findings.filter((f) => f.checkId !== 'default-service-account' || !optedOut.has(f.resource.namespace ?? ''));
}

// ---- entry point ----

const SEVERITY_ORDER: Record<AuditSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function runAudit(handle: ClusterHandle): Promise<AuditReport> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const entries = await Promise.all(
    (Object.entries(KINDS) as Array<[keyof typeof KINDS, KindSpec]>).map(async ([key, spec]) => {
      try {
        const query = new URLSearchParams({ limit: '2000' });
        const list = await handle.raw.json<{ items?: KubeObject[] }>(resourcePath(spec.group, spec.version, spec.plural, { query }));
        return [key, list.items ?? []] as const;
      } catch (err) {
        errors.push(`${spec.kind}: ${err instanceof Error ? err.message : String(err)}`);
        return [key, [] as KubeObject[]] as const;
      }
    }),
  );
  const lists = Object.fromEntries(entries) as Lists;
  const ctx = handle.contextName;

  let findings: AuditFinding[] = [];
  const emit: Emit = (checkId, resource, message) => {
    const info = CHECK_BY_ID.get(checkId);
    if (!info) return;
    findings.push({
      checkId,
      severity: info.severity,
      category: info.category,
      title: info.title,
      message,
      remediation: info.remediation,
      resource,
    });
  };

  const sources = podSources(ctx, lists);
  for (const source of sources) auditPodSource(source, emit);
  auditPdb(ctx, sources, lists, emit);
  auditRbac(ctx, lists, emit);
  auditNetwork(ctx, lists, emit);
  auditConfigMaps(ctx, lists, emit);
  auditNodes(ctx, lists, emit);

  findings = pruneDefaultSaFindings(findings, lists);
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.checkId.localeCompare(b.checkId) ||
      `${a.resource.namespace ?? ''}/${a.resource.name}`.localeCompare(`${b.resource.namespace ?? ''}/${b.resource.name}`),
  );

  const truncated = findings.length > MAX_FINDINGS;
  return {
    findings: truncated ? findings.slice(0, MAX_FINDINGS) : findings,
    checks: AUDIT_CHECKS,
    stats: {
      resourcesScanned: Object.values(lists).reduce((sum, items) => sum + items.length, 0),
      checksRun: AUDIT_CHECKS.length,
      durationMs: Date.now() - startedAt,
    },
    errors,
    truncated,
  };
}
