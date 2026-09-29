import type { KubeObject, ObjectSignal } from '@kubus/shared';

/**
 * Why a pod has not been scheduled, read from what the scheduler leaves
 * behind: the PodScheduled=False condition on the pod, or its latest
 * FailedScheduling event when the condition says nothing useful. Pure, so
 * the workload problem banner and the pod rows share one reading.
 */

export interface SchedulingIssue {
  /** "0/3 nodes available, Insufficient cpu (2), untolerated taint dedicated (1)". */
  summary: string;
  /** The row-sized answer: "Insufficient cpu". */
  short: string;
  /** The scheduler's message in full. */
  message: string;
  /** When the scheduler last reported it (the FailedScheduling event). */
  at?: string;
  /** The node this pod is pinned to (DaemonSet pods), or one the message names. */
  node?: string;
}

interface SchedulerReason {
  count?: number;
  text: string;
}

const AVAILABLE_RE = /^(\d+)\/(\d+) nodes are available:?\s*/;

/**
 * Split "0/3 nodes are available: 1 node(s) had untolerated taint {a: }, 2
 * Insufficient cpu. preemption: …" into its per-reason counts. Everything
 * from the first sentence break on is preemption detail, not a reason.
 */
export function parseSchedulerMessage(message: string): { available?: string; reasons: SchedulerReason[] } {
  const head = AVAILABLE_RE.exec(message);
  if (!head) return { reasons: [] };
  const rest = message.slice(head[0].length);
  const end = rest.search(/\.(\s|$)/);
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  const reasons = body
    .split(/,\s+(?=\d+\s)/)
    .map((part) => {
      const m = /^(\d+)\s+(.*)$/.exec(part.trim());
      return m ? { count: Number(m[1]), text: m[2]! } : { text: part.trim() };
    })
    .filter((r) => r.text);
  return { available: `${head[1]}/${head[2]}`, reasons };
}

/** The scheduler's phrasing, shortened to what a pod row has room for. */
export function shortSchedulerReason(text: string): string {
  const insufficient = /Insufficient\s+(\S+)/.exec(text);
  if (insufficient) return `Insufficient ${insufficient[1]}`;
  const taint = /untolerated taint(?:\(s\))?\s*(?:\{([^:}]+)[^}]*\})?/.exec(text);
  if (taint) return taint[1] ? `untolerated taint ${taint[1].trim()}` : 'untolerated taint';
  if (/node affinity\/selector/.test(text)) return 'node affinity/selector mismatch';
  if (/pod anti-affinity/.test(text)) return 'pod anti-affinity';
  if (/pod affinity/.test(text)) return 'pod affinity';
  if (/free ports/.test(text)) return 'host port in use';
  if (/were unschedulable/.test(text)) return 'node cordoned';
  if (/volume node affinity conflict/.test(text)) return 'volume node affinity conflict';
  if (/unbound immediate PersistentVolumeClaims/.test(text)) return 'unbound PersistentVolumeClaim';
  if (/Too many pods/.test(text)) return 'Too many pods';
  return text.replace(/^node\(s\)\s+(?:had\s+)?/, '');
}

/** Summary and short reason for one scheduler message. */
export function describeSchedulerMessage(message: string): { summary: string; short: string } {
  const { available, reasons } = parseSchedulerMessage(message);
  if (!available || !reasons.length) {
    // Not the "N/M nodes are available" shape (gates, plugin errors):
    // its first sentence is the best one-liner there is.
    const first = message.split(/\.(\s|$)/)[0]!.trim() || message;
    return { summary: first, short: first };
  }
  const shorts = reasons.map((r) => shortSchedulerReason(r.text));
  const unique = [...new Set(shorts)];
  const counted = reasons.length > 1 ? reasons.map((r, i) => (r.count !== undefined ? `${shorts[i]} (${r.count})` : shorts[i]!)) : shorts;
  return { summary: `${available} nodes available, ${counted.join(', ')}`, short: unique.join(', ') };
}

/** Node names an API or scheduler message quotes: `node "worker-2"`. */
export function nodeNamesIn(message: string | undefined): string[] {
  if (!message) return [];
  const names = new Set<string>();
  for (const m of message.matchAll(/\bnodes?\s+"([a-z0-9]([-a-z0-9.]*[a-z0-9])?)"/gi)) names.add(m[1]!);
  return [...names];
}

interface NodeSelectorTerm {
  matchFields?: Array<{ key?: string; operator?: string; values?: string[] }>;
}

/**
 * The node a DaemonSet pod is pinned to. The controller expresses the pin
 * as required node affinity on metadata.name, not as spec.nodeName, so the
 * scheduler can still refuse it.
 */
export function pinnedNode(pod: KubeObject): string | undefined {
  const affinity = (pod.spec as { affinity?: { nodeAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms?: NodeSelectorTerm[] } } } } | undefined)?.affinity;
  for (const term of affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []) {
    for (const field of term.matchFields ?? []) {
      if (field.key === 'metadata.name' && field.operator === 'In' && field.values?.length === 1) return field.values[0];
    }
  }
  return undefined;
}

interface PodSchedulingShape {
  phase?: string;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>;
}

/**
 * Why this pod is waiting for a node, or undefined when it has one (or is
 * past Pending). `warnings` is the pod's entry from the cluster signals, the
 * event cache the Overview reads; its FailedScheduling message stands in when
 * the condition carries none, and its timestamp dates the last attempt.
 */
export function podSchedulingIssue(pod: KubeObject, warnings?: ObjectSignal['warnings']): SchedulingIssue | undefined {
  const status = pod.status as PodSchedulingShape | undefined;
  const spec = pod.spec as { nodeName?: string; schedulingGates?: Array<{ name?: string }> } | undefined;
  if (pod.metadata.deletionTimestamp || spec?.nodeName || (status?.phase && status.phase !== 'Pending')) return undefined;
  const condition = status?.conditions?.find((c) => c.type === 'PodScheduled');
  if (condition?.status === 'True') return undefined;
  const uid = pod.metadata.uid;
  const event = warnings?.find((w) => w.reason === 'FailedScheduling' && (!w.uid || !uid || w.uid === uid));
  const node = pinnedNode(pod);
  if (condition?.reason === 'SchedulingGated') {
    const gates = (spec?.schedulingGates ?? []).map((g) => g.name).filter(Boolean);
    const short = gates.length ? `scheduling gate ${gates.join(', ')}` : 'scheduling gates';
    return { summary: `held by ${short}`, short, message: condition.message ?? 'Scheduling is blocked by scheduling gates.', node };
  }
  const message = condition?.status === 'False' && condition.message ? condition.message : event?.message;
  if (!message) return undefined;
  const { summary, short } = describeSchedulerMessage(message);
  return { summary, short, message, at: event?.lastTimestamp ?? condition?.lastTransitionTime, node: node ?? nodeNamesIn(message)[0] };
}
