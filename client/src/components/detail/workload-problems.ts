import type { KubeObject, ObjectSignal } from '@kubus/shared';
import { podSummary } from '../../kube-display.js';
import type { ProblemItem } from './ProblemBanner.js';
import { podSchedulingIssue, type SchedulingIssue } from './scheduling.js';
import { diagnosePod } from './pod-diagnosis.js';

/**
 * The pure half of a workload's "why isn't this ready" banner, shared by the
 * Deployment, StatefulSet and DaemonSet overviews: failing conditions in
 * full, the pods' own reasons grouped by state, and the controller's recent
 * create failures. Links are attached by the caller, which can navigate.
 */

export interface WorkloadProblem extends ProblemItem {
  /** Nodes the problem names (a DaemonSet pod's target node). */
  nodes?: string[];
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** Warning events of one pod or workload, from the cluster signals. */
export type WarningsFor = (kind: string, name: string) => ObjectSignal['warnings'] | undefined;

/** Conditions that are not in their healthy state, in full. */
export function conditionProblems(conditions: Condition[] | undefined, goodWhen: (type: string) => 'True' | 'False'): WorkloadProblem[] {
  const items: WorkloadProblem[] = [];
  for (const c of conditions ?? []) {
    if (c.status === goodWhen(c.type) || c.status === 'Unknown') continue;
    items.push({ title: `${c.type}: ${c.reason ?? c.status}`, message: c.message, at: c.lastTransitionTime });
  }
  return items;
}

const HEALTHY = new Set(['Running', 'Succeeded', 'Completed']);

type ContainerStates = Array<{ state?: { waiting?: { message?: string }; terminated?: { message?: string } } }>;

function containerMessage(pod: KubeObject): string | undefined {
  const st = pod.status as { initContainerStatuses?: ContainerStates; containerStatuses?: ContainerStates } | undefined;
  for (const cs of [...(st?.initContainerStatuses ?? []), ...(st?.containerStatuses ?? [])]) {
    const message = cs.state?.waiting?.message ?? cs.state?.terminated?.message;
    if (message) return message;
  }
  return undefined;
}

/**
 * The pod's latest warning (a failed mount, a sandbox error) for states that
 * carry no message of their own. Scheduling failures are left out: once the
 * pod has a node they are history.
 */
function latestWarning(warnings: ObjectSignal['warnings'] | undefined, uid: string | undefined): ObjectSignal['warnings'][number] | undefined {
  return warnings?.find((w) => w.reason !== 'FailedScheduling' && (!w.uid || !uid || w.uid === uid));
}

const plural = (n: number) => `${n} pod${n === 1 ? '' : 's'}`;

/**
 * A failing pod's reason in words ("Image app:1.2 cannot be pulled: image or
 * tag not found") with the kubelet's message kept as `raw`; the kubelet
 * message alone when no plain-language reading applies.
 */
function podReason(pod: KubeObject): { message?: string; raw?: string } {
  const diagnosis = diagnosePod(pod).find((d) => d.kind !== 'unschedulable');
  const raw = containerMessage(pod);
  if (diagnosis) return { message: diagnosis.headline, raw: diagnosis.raw ?? raw };
  return { message: raw };
}

/**
 * The pods' reasons, grouped the way `kubectl get pods` would make you
 * piece them together: "2 pods CrashLoopBackOff" with the first waiting
 * message, and for pods no node would take "1 pod Pending: 0/3 nodes
 * available, Insufficient cpu" with the scheduler's full answer.
 */
export function podProblems(pods: KubeObject[], warningsFor?: WarningsFor): WorkloadProblem[] {
  const scheduling = new Map<string, { count: number; issue: SchedulingIssue; at?: string; nodes: Set<string> }>();
  const groups = new Map<string, { count: number; message?: string; raw?: string; at?: string }>();
  for (const pod of pods) {
    const summary = podSummary(pod);
    if (HEALTHY.has(summary.status)) continue;
    const warnings = warningsFor?.('Pod', pod.metadata.name);
    const issue = podSchedulingIssue(pod, warnings);
    if (issue) {
      const entry = scheduling.get(issue.summary) ?? { count: 0, issue, nodes: new Set<string>() };
      entry.count += 1;
      if (issue.at && (!entry.at || issue.at > entry.at)) entry.at = issue.at;
      if (issue.node) entry.nodes.add(issue.node);
      scheduling.set(issue.summary, entry);
      continue;
    }
    const entry = groups.get(summary.status) ?? { count: 0 };
    entry.count += 1;
    if (!entry.message) {
      const reason = podReason(pod);
      entry.message = reason.message;
      entry.raw = reason.raw;
      if (!entry.message) {
        const warning = latestWarning(warnings, pod.metadata.uid);
        entry.message = warning ? `${warning.reason}: ${warning.message}` : undefined;
        entry.at = warning?.lastTimestamp;
      }
    }
    groups.set(summary.status, entry);
  }
  const items: WorkloadProblem[] = [];
  for (const { count, issue, at, nodes } of scheduling.values()) {
    items.push({ title: `${plural(count)} Pending: ${issue.summary}`, message: issue.message, at, ...(nodes.size && { nodes: [...nodes] }) });
  }
  // Neighbouring states (ErrImagePull → ImagePullBackOff) carry the same
  // message; say it once under a combined headline.
  const byMessage = new Map<string, { titles: string[]; at?: string; raw?: string }>();
  for (const [state, entry] of groups) {
    const key = entry.message ?? `\0${state}`;
    const merged = byMessage.get(key) ?? { titles: [] };
    merged.titles.push(`${plural(entry.count)} ${state}`);
    merged.at ??= entry.at;
    merged.raw ??= entry.raw;
    byMessage.set(key, merged);
  }
  for (const [key, { titles, at, raw }] of byMessage) {
    items.push({ title: titles.join(' · '), message: key.startsWith('\0') ? undefined : key, ...(at && { at }), ...(raw && raw !== key && { raw }) });
  }
  return items;
}

/** Controller events that explain missing pods (quota refusals, placement failures). */
const CREATE_FAILURES = new Set(['FailedCreate', 'FailedPlacement', 'FailedDaemonPod']);

/**
 * A StatefulSet's or DaemonSet's own create failures. They have no
 * ReplicaFailure condition, so a refused pod ("exceeded quota") is only
 * ever an event on the controller. Events of an earlier object with the
 * same name (uninstalled and reinstalled within the signal window) are not
 * this one's problem.
 */
export function controllerEventProblems(warnings: ObjectSignal['warnings'] | undefined, uid: string | undefined): WorkloadProblem[] {
  return (warnings ?? [])
    .filter((w) => CREATE_FAILURES.has(w.reason) && (!w.uid || !uid || w.uid === uid))
    .map((w) => ({ title: w.reason, message: w.message, count: w.total ?? w.count, at: w.lastTimestamp }));
}

/** "2 Running · 1 ImagePullBackOff" — pod states by frequency. */
export function podStatusSummary(pods: KubeObject[]): string | undefined {
  if (!pods.length) return undefined;
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const s = podSummary(pod).status;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
}
