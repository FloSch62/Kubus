import type { KubeObject } from '@kubus/shared';

interface ContainerStatus {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string }; running?: unknown };
}

export interface PodSummary {
  ready: string;
  status: string;
  restarts: number;
  node?: string;
}

const podSummaryCache = new WeakMap<KubeObject, PodSummary>();

/**
 * Summarize a pod for display. Cached per object identity: watch updates
 * replace the object, so a given instance's summary never changes. Callers
 * must treat the result as read-only.
 */
export function podSummary(pod: KubeObject): PodSummary {
  let summary = podSummaryCache.get(pod);
  if (!summary) {
    summary = computePodSummary(pod);
    podSummaryCache.set(pod, summary);
  }
  return summary;
}

function computePodSummary(pod: KubeObject): PodSummary {
  const status = pod.status as
    | {
        phase?: string;
        reason?: string;
        containerStatuses?: ContainerStatus[];
        initContainerStatuses?: ContainerStatus[];
      }
    | undefined;
  const spec = pod.spec as { nodeName?: string; containers?: unknown[] } | undefined;
  const statuses = status?.containerStatuses ?? [];
  const total = (spec?.containers ?? []).length || statuses.length;
  let readyCount = 0;
  let restarts = 0;
  for (const c of statuses) {
    if (c.ready) readyCount++;
    restarts += c.restartCount ?? 0;
  }

  let display = status?.reason ?? status?.phase ?? 'Unknown';
  if (pod.metadata.deletionTimestamp) {
    display = 'Terminating';
  } else {
    for (const c of [...(status?.initContainerStatuses ?? []), ...statuses]) {
      const waiting = c.state?.waiting?.reason;
      const terminated = c.state?.terminated?.reason;
      if (waiting && waiting !== 'PodInitializing') {
        display = waiting;
        break;
      }
      if (terminated && terminated !== 'Completed' && display === 'Running') {
        display = terminated;
        break;
      }
    }
  }
  return { ready: `${readyCount}/${total}`, status: display, restarts, node: spec?.nodeName };
}

export function workloadReady(obj: KubeObject): string {
  const spec = obj.spec as { replicas?: number } | undefined;
  const status = obj.status as { readyReplicas?: number; replicas?: number } | undefined;
  return `${status?.readyReplicas ?? 0}/${spec?.replicas ?? status?.replicas ?? 0}`;
}

export function nodeStatus(node: KubeObject): string {
  const conditions = (node.status as { conditions?: Array<{ type: string; status: string }> })?.conditions ?? [];
  const ready = conditions.find((c) => c.type === 'Ready');
  let s = ready?.status === 'True' ? 'Ready' : 'NotReady';
  if ((node.spec as { unschedulable?: boolean })?.unschedulable) s += ',SchedulingDisabled';
  return s;
}

const NODE_ROLE_PREFIX = 'node-role.kubernetes.io/';

export function nodeRoles(node: KubeObject): string {
  return Object.keys(node.metadata.labels ?? {})
    .flatMap((l) => (l.startsWith(NODE_ROLE_PREFIX) ? [l.slice(NODE_ROLE_PREFIX.length)] : []))
    .join(',');
}

export function nodeAddress(node: KubeObject, type: string): string {
  const addresses = (node.status as { addresses?: Array<{ type: string; address: string }> } | undefined)?.addresses ?? [];
  return addresses.find((a) => a.type === type)?.address ?? '';
}

export function nodeTaints(node: KubeObject): string {
  const taints = (node.spec as { taints?: Array<{ key?: string; value?: string; effect?: string }> } | undefined)?.taints ?? [];
  return taints
    .flatMap((t) => {
      const text = `${t.key ?? ''}${t.value ? `=${t.value}` : ''}${t.effect ? `:${t.effect}` : ''}`;
      return text ? [text] : [];
    })
    .join(', ');
}

export function nodeConditions(node: KubeObject): string {
  const conditions = (node.status as { conditions?: Array<{ type: string; status: string }> } | undefined)?.conditions ?? [];
  return conditions
    .flatMap((c) => (c.status !== nodeGoodConditionStatus(c.type) ? [`${c.type}=${c.status}`] : []))
    .join(', ');
}

function nodeGoodConditionStatus(type: string): string {
  return type === 'Ready' ? 'True' : 'False';
}

/**
 * HPA conditions that indicate scaling is blocked or capped (empty when
 * healthy): AbleToScale/ScalingActive are bad when False, ScalingLimited is
 * bad when True (replica count pinned at min/max).
 */
export function hpaProblems(hpa: KubeObject): string {
  const conditions = (hpa.status as { conditions?: Array<{ type?: string; status?: string; reason?: string }> } | undefined)?.conditions ?? [];
  return conditions
    .flatMap((c) => {
      const bad = c.type === 'ScalingLimited' ? c.status === 'True' : c.status === 'False';
      return bad && c.type ? [`${c.type}${c.reason ? ` (${c.reason})` : ''}`] : [];
    })
    .join(', ');
}

export function servicePorts(svc: KubeObject): string {
  const ports = (svc.spec as { ports?: Array<{ port: number; protocol?: string; nodePort?: number }> })?.ports ?? [];
  return ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`).join(', ');
}

/** Addresses assigned by the cloud load balancer (IP on most providers, hostname on some). */
export function serviceLoadBalancerAddresses(svc: KubeObject): string {
  const ingress = (svc.status as { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } | undefined)?.loadBalancer?.ingress ?? [];
  return ingress.flatMap((entry) => entry.ip ?? entry.hostname ?? []).join(', ');
}

export function ingressHosts(ing: KubeObject): string {
  const rules = (ing.spec as { rules?: Array<{ host?: string }> })?.rules ?? [];
  return rules.map((r) => r.host ?? '*').join(', ');
}

export function dataKeyCount(obj: KubeObject): number {
  return Object.keys((obj.data as Record<string, unknown> | undefined) ?? {}).length;
}

/** Served CRD versions in spec order, the storage version marked with an asterisk. */
export function crdVersions(crd: KubeObject): string {
  const versions = (crd.spec as { versions?: Array<{ name: string; served?: boolean; storage?: boolean }> })?.versions ?? [];
  const served = versions.filter((v) => v.served !== false);
  return (served.length ? served : versions).map((v) => `${v.name}${v.storage ? '*' : ''}`).join(', ');
}

/**
 * Coarse CRD lifecycle status for the list Status column. Empty until the
 * apiserver reports conditions so a just-created CRD shows no chip.
 */
export function crdStatus(crd: KubeObject): string {
  if (crd.metadata.deletionTimestamp) return 'Terminating';
  const conditions = (crd.status as { conditions?: Array<{ type?: string; status?: string }> } | undefined)?.conditions ?? [];
  const has = (type: string, status: string) => conditions.some((c) => c.type === type && c.status === status);
  if (has('Established', 'True')) return 'Active';
  if (has('NamesAccepted', 'False')) return 'NameConflict';
  return conditions.length ? 'NotEstablished' : '';
}

/**
 * Coarse Job lifecycle phase for the list Status column. Terminal conditions
 * win; otherwise suspension beats activity so a paused Job doesn't read as
 * pending work.
 */
export function jobPhase(job: KubeObject): string {
  const spec = job.spec as { suspend?: boolean } | undefined;
  const status = job.status as { conditions?: Array<{ type?: string; status?: string }>; active?: number } | undefined;
  const has = (type: string) => (status?.conditions ?? []).some((c) => c.type === type && c.status === 'True');
  if (has('Failed')) return 'Failed';
  if (has('Complete')) return 'Complete';
  if (spec?.suspend) return 'Suspended';
  if ((status?.active ?? 0) > 0) return 'Running';
  return 'Pending';
}

/** The object's controlling owner, falling back to the first ownerReference. */
export function ownerReference(obj: KubeObject): { kind: string; name: string } | undefined {
  const refs = obj.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref ? { kind: ref.kind, name: ref.name } : undefined;
}

export function jobStatus(job: KubeObject): { completions: string; duration: string } {
  const spec = job.spec as { completions?: number } | undefined;
  const status = job.status as { succeeded?: number; startTime?: string; completionTime?: string } | undefined;
  const completions = `${status?.succeeded ?? 0}/${spec?.completions ?? 1}`;
  let duration = '';
  if (status?.startTime) {
    const endMs = status.completionTime ? Date.parse(status.completionTime) : Date.now();
    const s = Math.floor((endMs - Date.parse(status.startTime)) / 1000);
    duration = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  }
  return { completions, duration };
}

export interface EventFields {
  type: string;
  reason: string;
  object: string;
  message: string;
  count: number;
  lastSeen?: string;
}

const eventFieldsCache = new WeakMap<KubeObject, EventFields>();

/** Extract display fields from an Event. Cached per object identity; treat the result as read-only. */
export function eventFields(e: KubeObject): EventFields {
  let fields = eventFieldsCache.get(e);
  if (!fields) {
    fields = computeEventFields(e);
    eventFieldsCache.set(e, fields);
  }
  return fields;
}

function computeEventFields(e: KubeObject): EventFields {
  const ev = e as KubeObject & {
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    lastTimestamp?: string;
    eventTime?: string;
    firstTimestamp?: string;
    involvedObject?: { kind?: string; name?: string };
  };
  return {
    type: ev.type ?? '',
    reason: ev.reason ?? '',
    object: `${ev.involvedObject?.kind ?? ''}/${ev.involvedObject?.name ?? ''}`,
    message: ev.message ?? '',
    count: ev.count ?? 1,
    lastSeen: ev.lastTimestamp ?? ev.eventTime ?? ev.firstTimestamp ?? e.metadata.creationTimestamp,
  };
}

/** Containers of a pod spec (incl. init containers). */
export function podContainerNames(pod: KubeObject): string[] {
  const spec = pod.spec as { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> } | undefined;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c) => c.name);
}

export interface DebugContainerInfo {
  name: string;
  image?: string;
  target?: string;
  /** 'running' | 'waiting' | 'terminated' | 'unknown' */
  state: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Ephemeral (debug) containers of a pod, joined with their live status. */
export function podDebugContainers(pod: KubeObject): DebugContainerInfo[] {
  const spec = pod.spec as { ephemeralContainers?: Array<{ name: string; image?: string; targetContainerName?: string }> } | undefined;
  const status = pod.status as {
    ephemeralContainerStatuses?: Array<{
      name: string;
      state?: { running?: { startedAt?: string }; waiting?: { reason?: string }; terminated?: { startedAt?: string; finishedAt?: string; reason?: string } };
    }>;
  } | undefined;
  const statusByName = new Map((status?.ephemeralContainerStatuses ?? []).map((s) => [s.name, s]));
  return (spec?.ephemeralContainers ?? []).map((c) => {
    const st = statusByName.get(c.name)?.state;
    const state = st?.running ? 'running' : st?.terminated ? 'terminated' : st?.waiting ? (st.waiting.reason ?? 'waiting') : 'unknown';
    return {
      name: c.name,
      image: c.image,
      target: c.targetContainerName,
      state,
      startedAt: st?.running?.startedAt ?? st?.terminated?.startedAt,
      finishedAt: st?.terminated?.finishedAt,
    };
  });
}

/** True when the pod has at least one live debug (ephemeral) container. */
export function hasRunningDebugContainer(pod: KubeObject): boolean {
  return podDebugContainers(pod).some((c) => c.state === 'running');
}

const QUANTITY_BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const QUANTITY_DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

const QUANTITY_RE = /^([+-]?[0-9.eE+-]+?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/;

/** Parse a Kubernetes quantity ("500m", "1Gi", "128974848") to base units. */
export function parseQuantity(q: string | undefined): number {
  if (!q) return 0;
  const m = QUANTITY_RE.exec(q.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  if (Number.isNaN(value)) return 0;
  return value * (QUANTITY_BINARY[m[2] ?? ''] ?? QUANTITY_DECIMAL[m[2] ?? ''] ?? 1);
}

/**
 * Whether a printer-column or status-field name likely carries a health-like
 * value ("Ready", "Operational State", "operationalState", "npp-state"…) —
 * such values render as colored StatusChips.
 */
export function statusLikeName(name: string): boolean {
  const last = name
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLowerCase();
  return !!last && STATUS_LIKE_WORDS.has(last);
}

const STATUS_LIKE_WORDS = new Set(['ready', 'readiness', 'state', 'status', 'phase', 'health', 'healthy', 'available', 'robustness']);

interface ContainerWithResources {
  restartPolicy?: string;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}

/** Per-container requests/limits parsed to millicores / bytes; undefined when unset. */
export interface ContainerResources {
  cpuRequestMilli?: number;
  memRequestBytes?: number;
  cpuLimitMilli?: number;
  memLimitBytes?: number;
  ephemeralRequestBytes?: number;
  ephemeralLimitBytes?: number;
}

export function containerResources(c: ContainerWithResources): ContainerResources {
  return {
    cpuRequestMilli: quantityMilli(c.resources?.requests?.cpu),
    memRequestBytes: quantityBytes(c.resources?.requests?.memory),
    cpuLimitMilli: quantityMilli(c.resources?.limits?.cpu),
    memLimitBytes: quantityBytes(c.resources?.limits?.memory),
    ephemeralRequestBytes: quantityBytes(c.resources?.requests?.['ephemeral-storage']),
    ephemeralLimitBytes: quantityBytes(c.resources?.limits?.['ephemeral-storage']),
  };
}

function quantityMilli(q: string | undefined): number | undefined {
  return q === undefined ? undefined : Math.round(parseQuantity(q) * 1000);
}

function quantityBytes(q: string | undefined): number | undefined {
  return q === undefined ? undefined : Math.round(parseQuantity(q));
}

function isRestartableInitContainer(container: ContainerWithResources): boolean {
  return container.restartPolicy === 'Always';
}

// Request totals are read per row per grid pass by the list CPU/Memory cells
// and the Node allocation lookup; cache per object (watch updates replace objects).
const podRequestCache = new WeakMap<KubeObject, { cpuMilli: number; memoryBytes: number }>();

/**
 * Effective scheduling request of a pod: sidecars + max(app containers, init
 * containers) + pod overhead — mirrors how the scheduler reserves resources.
 */
export function podRequestTotals(pod: KubeObject): { cpuMilli: number; memoryBytes: number } {
  const cached = podRequestCache.get(pod);
  if (cached) return cached;
  const spec = pod.spec as
    | {
        containers?: ContainerWithResources[];
        initContainers?: ContainerWithResources[];
        overhead?: Record<string, string>;
      }
    | undefined;
  let appCpu = 0;
  let appMemory = 0;
  for (const c of spec?.containers ?? []) {
    appCpu += quantityMilli(c.resources?.requests?.cpu) ?? 0;
    appMemory += quantityBytes(c.resources?.requests?.memory) ?? 0;
  }
  let sidecarCpu = 0;
  let sidecarMemory = 0;
  let initCpu = 0;
  let initMemory = 0;
  for (const c of spec?.initContainers ?? []) {
    const cpu = quantityMilli(c.resources?.requests?.cpu) ?? 0;
    const memory = quantityBytes(c.resources?.requests?.memory) ?? 0;
    if (isRestartableInitContainer(c)) {
      sidecarCpu += cpu;
      sidecarMemory += memory;
    } else {
      initCpu = Math.max(initCpu, cpu);
      initMemory = Math.max(initMemory, memory);
    }
  }
  const totals = {
    cpuMilli: sidecarCpu + Math.max(appCpu, initCpu) + Math.round(parseQuantity(spec?.overhead?.cpu) * 1000),
    memoryBytes: sidecarMemory + Math.max(appMemory, initMemory) + Math.round(parseQuantity(spec?.overhead?.memory)),
  };
  podRequestCache.set(pod, totals);
  return totals;
}

/** Strip noisy fields for diff/display normalization. */
export function normalizeForDiff(obj: KubeObject): KubeObject {
  const clone = JSON.parse(JSON.stringify(obj)) as KubeObject;
  delete clone.status;
  const meta = clone.metadata as unknown as Record<string, unknown>;
  for (const key of ['uid', 'resourceVersion', 'creationTimestamp', 'generation', 'managedFields', 'selfLink']) {
    delete meta[key];
  }
  const annotations = meta.annotations as Record<string, string> | undefined;
  if (annotations) {
    delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
    if (!Object.keys(annotations).length) delete meta.annotations;
  }
  return clone;
}

/** Hide Kubernetes managed fields while preserving the editable resource shape. */
export function withoutManagedFields(obj: KubeObject): KubeObject {
  const clone = JSON.parse(JSON.stringify(obj)) as KubeObject;
  const meta = clone.metadata as unknown as Record<string, unknown>;
  delete meta.managedFields;
  return clone;
}
