import type { PodEnvVar } from '@kubus/shared';

/**
 * Typed slices of a pod (or pod template) spec that the container panels
 * render, plus the pure helpers that turn them into display rows. Shared by
 * the Pod overview (live containers) and workload overviews (templates).
 */

export interface Probe {
  httpGet?: { path?: string; port?: number | string; scheme?: string };
  tcpSocket?: { port?: number | string };
  exec?: { command?: string[] };
  grpc?: { port?: number; service?: string };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
}

export interface EnvVarSpec {
  name: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: { name?: string; key?: string };
    secretKeyRef?: { name?: string; key?: string };
    fieldRef?: { fieldPath?: string };
    resourceFieldRef?: { resource?: string; containerName?: string };
  };
}

export interface EnvFromSpec {
  prefix?: string;
  configMapRef?: { name?: string };
  secretRef?: { name?: string };
}

export interface ContainerSpec {
  name: string;
  image?: string;
  imagePullPolicy?: string;
  restartPolicy?: string;
  command?: string[];
  args?: string[];
  workingDir?: string;
  ports?: Array<{ containerPort: number; protocol?: string; name?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  env?: EnvVarSpec[];
  envFrom?: EnvFromSpec[];
}

export interface ContainerStateDetail {
  reason?: string;
  message?: string;
  exitCode?: number;
  signal?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface ContainerStatus {
  name: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  state?: { running?: ContainerStateDetail; waiting?: ContainerStateDetail; terminated?: ContainerStateDetail };
  lastState?: { terminated?: ContainerStateDetail };
}

export interface VolumeSpec {
  name: string;
  [key: string]: unknown;
}

export type VolumeRefKind = 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim' | 'ServiceAccount';

/** One source of a projected volume: "secret/app-tls", "serviceAccountToken (audience vault, 3600s)". */
export interface VolumeSourceRef {
  label: string;
  refKind?: VolumeRefKind;
  refName?: string;
}

export interface VolumeInfo {
  type: string;
  detail?: string;
  refKind?: VolumeRefKind;
  refName?: string;
  /** Projected volumes: each source it merges into the one directory. */
  sources?: VolumeSourceRef[];
}

interface DownwardApiItem {
  path?: string;
  fieldRef?: { fieldPath?: string };
  resourceFieldRef?: { resource?: string };
}

/** "metadata.labels, limits.memory" — the fields a downward API source exposes. */
function downwardFields(items: DownwardApiItem[] | undefined): string {
  return (items ?? [])
    .map((i) => i.fieldRef?.fieldPath ?? i.resourceFieldRef?.resource ?? i.path ?? '')
    .filter(Boolean)
    .join(', ');
}

interface ProjectedSource {
  secret?: { name?: string; optional?: boolean };
  configMap?: { name?: string; optional?: boolean };
  serviceAccountToken?: { audience?: string; expirationSeconds?: number; path?: string };
  downwardAPI?: { items?: DownwardApiItem[] };
  clusterTrustBundle?: { name?: string; signerName?: string };
  podCertificate?: { signerName?: string };
}

/**
 * The sources a projected volume merges. A service account token is minted
 * for the pod's own service account, so it links there.
 */
function projectedSources(sources: ProjectedSource[] | undefined, serviceAccountName: string | undefined): VolumeSourceRef[] {
  const out: VolumeSourceRef[] = [];
  for (const src of sources ?? []) {
    if (src.secret) {
      out.push({ label: `secret/${src.secret.name ?? ''}${src.secret.optional ? ' (optional)' : ''}`, refKind: 'Secret', refName: src.secret.name });
    } else if (src.configMap) {
      out.push({ label: `configMap/${src.configMap.name ?? ''}${src.configMap.optional ? ' (optional)' : ''}`, refKind: 'ConfigMap', refName: src.configMap.name });
    } else if (src.serviceAccountToken) {
      const t = src.serviceAccountToken;
      const account = serviceAccountName || 'default';
      const facts = [t.audience ? `audience ${t.audience}` : undefined, t.expirationSeconds !== undefined ? `${t.expirationSeconds}s` : undefined].filter(Boolean);
      out.push({ label: `serviceAccountToken/${account}${facts.length ? ` (${facts.join(', ')})` : ''}`, refKind: 'ServiceAccount', refName: account });
    } else if (src.downwardAPI) {
      const fields = downwardFields(src.downwardAPI.items);
      out.push({ label: `downwardAPI${fields ? ` (${fields})` : ''}` });
    } else if (src.clusterTrustBundle) {
      out.push({ label: `clusterTrustBundle/${src.clusterTrustBundle.name ?? src.clusterTrustBundle.signerName ?? ''}` });
    } else if (src.podCertificate) {
      out.push({ label: `podCertificate/${src.podCertificate.signerName ?? ''}` });
    } else {
      const type = Object.keys(src)[0];
      if (type) out.push({ label: type });
    }
  }
  return out;
}

/**
 * Human label + navigable reference for a pod volume. `serviceAccountName`
 * is the pod's, for projected token sources.
 */
export function volumeInfo(v: VolumeSpec, serviceAccountName?: string): VolumeInfo {
  if (v.persistentVolumeClaim) {
    const claim = (v.persistentVolumeClaim as { claimName?: string }).claimName;
    return { type: 'persistentVolumeClaim', detail: claim, refKind: 'PersistentVolumeClaim', refName: claim };
  }
  if (v.configMap) {
    const name = (v.configMap as { name?: string }).name;
    return { type: 'configMap', detail: name, refKind: 'ConfigMap', refName: name };
  }
  if (v.secret) {
    const name = (v.secret as { secretName?: string }).secretName;
    return { type: 'secret', detail: name, refKind: 'Secret', refName: name };
  }
  if (v.hostPath) return { type: 'hostPath', detail: (v.hostPath as { path?: string }).path };
  if (v.projected) {
    const sources = projectedSources((v.projected as { sources?: ProjectedSource[] }).sources, serviceAccountName);
    return sources.length ? { type: 'projected', sources } : { type: 'projected' };
  }
  if (v.downwardAPI) {
    const fields = downwardFields((v.downwardAPI as { items?: DownwardApiItem[] }).items);
    return fields ? { type: 'downwardAPI', detail: fields } : { type: 'downwardAPI' };
  }
  if (v.image) {
    const img = v.image as { reference?: string; pullPolicy?: string };
    return { type: 'image', detail: `${img.reference ?? ''}${img.pullPolicy ? ` (${img.pullPolicy})` : ''}` };
  }
  const type = Object.keys(v).find((k) => k !== 'name') ?? 'unknown';
  return { type };
}

/** "configMap/app-config", "hostPath /var/log", "downwardAPI (metadata.labels)". */
export function volumeLabel(info: VolumeInfo): string {
  if (!info.detail) return info.type;
  if (info.type === 'downwardAPI') return `${info.type} (${info.detail})`;
  return info.detail.startsWith('/') ? `${info.type} ${info.detail}` : `${info.type}/${info.detail}`;
}

export type ProbeKind = 'readiness' | 'liveness' | 'startup';

export interface ProbeRow {
  kind: ProbeKind;
  target: string;
  timing: string;
  /** Live outcome where the API surfaces one (readiness → ready, startup → started). */
  state?: string;
}

const PROBE_KINDS: Array<[ProbeKind, 'readinessProbe' | 'livenessProbe' | 'startupProbe']> = [
  ['readiness', 'readinessProbe'],
  ['liveness', 'livenessProbe'],
  ['startup', 'startupProbe'],
];

/**
 * A probe port as the kubelet will dial it: a named port resolves against
 * the container's declared ports ("http (9898)"), and a name no port carries
 * says so, since the probe can only fail.
 */
export function probePort(port: number | string | undefined, ports: ContainerSpec['ports']): string {
  if (port === undefined) return '';
  if (typeof port === 'number' || /^\d+$/.test(port)) return String(port);
  const declared = (ports ?? []).find((p) => p.name === port);
  return declared ? `${port} (${declared.containerPort})` : `${port} (undeclared)`;
}

export function probeTarget(p: Probe, ports?: ContainerSpec['ports']): string {
  if (p.httpGet) return `${(p.httpGet.scheme ?? 'HTTP') === 'HTTPS' ? 'HTTPS' : 'HTTP'} ${p.httpGet.path ?? '/'} :${probePort(p.httpGet.port, ports)}`;
  if (p.tcpSocket) return `TCP :${probePort(p.tcpSocket.port, ports)}`;
  if (p.grpc) return `gRPC :${p.grpc.port ?? ''}${p.grpc.service ? ` ${p.grpc.service}` : ''}`;
  if (p.exec) return `exec ${(p.exec.command ?? []).join(' ')}`;
  return '';
}

export function probeTiming(p: Probe): string {
  return `delay ${p.initialDelaySeconds ?? 0}s · period ${p.periodSeconds ?? 10}s · timeout ${p.timeoutSeconds ?? 1}s · fail ${p.failureThreshold ?? 3}×`;
}

/**
 * The container's probes with a live outcome where Kubernetes reports one.
 * Liveness failures only ever show up as restarts. `live: false` (finished
 * pods, templates) suppresses outcomes — a Succeeded pod is expectedly
 * NotReady, and a template has no runtime at all.
 */
export function probeRows(c: ContainerSpec, st: ContainerStatus | undefined, live: boolean): ProbeRow[] {
  const rows: ProbeRow[] = [];
  for (const [kind, key] of PROBE_KINDS) {
    const probe = c[key];
    if (!probe) continue;
    const state = !live || !st ? undefined : kind === 'readiness' ? (st.ready ? 'Ready' : 'NotReady') : kind === 'startup' ? (st.started ? 'Started' : 'Pending') : undefined;
    rows.push({ kind, target: probeTarget(probe, c.ports), timing: probeTiming(probe), state });
  }
  return rows;
}

export interface MountRow {
  path: string;
  volume: string;
  /** Volume source, e.g. "configMap/app-config" or "emptyDir". */
  source: string;
  note?: string;
  refKind?: VolumeRefKind;
  refName?: string;
  /** Projected volumes: the sources merged into the mount. */
  sources?: VolumeSourceRef[];
}

/** The container's volume mounts joined with the pod's volume sources. */
export function mountRows(c: ContainerSpec, volumes: VolumeSpec[] | undefined, serviceAccountName?: string): MountRow[] {
  const byName = new Map((volumes ?? []).map((v) => [v.name, v]));
  return (c.volumeMounts ?? []).map((m) => {
    const vol = byName.get(m.name);
    const info = vol ? volumeInfo(vol, serviceAccountName) : undefined;
    const note = [m.subPath ? `subPath ${m.subPath}` : undefined, m.readOnly ? 'read-only' : undefined].filter(Boolean).join(' · ');
    return {
      path: m.mountPath,
      volume: m.name,
      source: info ? volumeLabel(info) : '',
      note: note || undefined,
      refKind: info?.refKind,
      refName: info?.refName,
      ...(info?.sources && { sources: info.sources }),
    };
  });
}

/**
 * A template container's declared environment in the same shape the pod env
 * endpoint resolves for live pods — literals carry their value, references
 * carry their source, and envFrom blocks become one "all keys" row each.
 */
export function templateEnv(c: ContainerSpec): PodEnvVar[] {
  const out: PodEnvVar[] = [];
  for (const from of c.envFrom ?? []) {
    const ref = from.configMapRef?.name ?? from.secretRef?.name;
    if (!ref) continue;
    out.push({
      name: `${from.prefix ?? ''}*`,
      redacted: !!from.secretRef,
      source: { type: from.secretRef ? 'secretRef' : 'configMapRef', ref },
    });
  }
  for (const env of c.env ?? []) {
    const vf = env.valueFrom;
    if (vf?.configMapKeyRef) out.push({ name: env.name, source: { type: 'configMapKeyRef', ref: vf.configMapKeyRef.name, key: vf.configMapKeyRef.key } });
    else if (vf?.secretKeyRef) out.push({ name: env.name, redacted: true, source: { type: 'secretKeyRef', ref: vf.secretKeyRef.name, key: vf.secretKeyRef.key } });
    else if (vf?.fieldRef) out.push({ name: env.name, source: { type: 'fieldRef', key: vf.fieldRef.fieldPath } });
    else if (vf?.resourceFieldRef) out.push({ name: env.name, source: { type: 'resourceFieldRef', key: vf.resourceFieldRef.resource } });
    else out.push({ name: env.name, value: env.value ?? '', source: { type: 'literal' } });
  }
  return out;
}

/** StatusChip word + detail for a container's current state. */
export function containerState(st: ContainerStatus | undefined): { state?: string; message?: string; shellable: boolean } {
  if (!st?.state) return { shellable: false };
  if (st.state.running) return { state: 'Running', shellable: true };
  if (st.state.waiting) return { state: st.state.waiting.reason ?? 'Waiting', message: st.state.waiting.message, shellable: false };
  if (st.state.terminated) {
    const t = st.state.terminated;
    const exit = t.exitCode !== undefined && t.exitCode !== 0 ? ` (exit ${t.exitCode})` : '';
    return { state: t.reason ?? 'Terminated', message: t.message ?? (exit ? `Exited with code ${t.exitCode}` : undefined), shellable: false };
  }
  return { shellable: false };
}
