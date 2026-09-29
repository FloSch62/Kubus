import type { KubeObject } from '@kubus/shared';
import { podSummary } from '../../kube-display.js';
import { naturalCompare } from '../natural-sort.js';
import { pinnedNode, podSchedulingIssue, type SchedulingIssue } from './scheduling.js';

/**
 * Which nodes a DaemonSet should run on, and why the others are left out:
 * the controller's own placement test (node selector, required node
 * affinity, taints its pods don't tolerate), evaluated per node. Pure, so
 * the node table in the DaemonSet overview can be tested without a cluster.
 */

export interface Toleration {
  key?: string;
  operator?: string;
  value?: string;
  effect?: string;
}

interface Taint {
  key: string;
  value?: string;
  effect: string;
}

interface NodeSelectorRequirement {
  key?: string;
  operator?: string;
  values?: string[];
}

interface NodeSelectorTerm {
  matchExpressions?: NodeSelectorRequirement[];
  matchFields?: NodeSelectorRequirement[];
}

export interface DaemonPodSpec {
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  hostNetwork?: boolean;
  affinity?: { nodeAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms?: NodeSelectorTerm[] } } };
}

/**
 * Tolerations the DaemonSet controller adds to every daemon pod, so node
 * trouble and cordons don't evict or block them.
 */
function defaultTolerations(spec: DaemonPodSpec): Toleration[] {
  const exists = (key: string, effect: string): Toleration => ({ key, operator: 'Exists', effect });
  return [
    exists('node.kubernetes.io/not-ready', 'NoExecute'),
    exists('node.kubernetes.io/unreachable', 'NoExecute'),
    exists('node.kubernetes.io/disk-pressure', 'NoSchedule'),
    exists('node.kubernetes.io/memory-pressure', 'NoSchedule'),
    exists('node.kubernetes.io/pid-pressure', 'NoSchedule'),
    exists('node.kubernetes.io/unschedulable', 'NoSchedule'),
    ...(spec.hostNetwork ? [exists('node.kubernetes.io/network-unavailable', 'NoSchedule')] : []),
  ];
}

/** Kubernetes' ToleratesTaint. */
export function tolerates(toleration: Toleration, taint: Taint): boolean {
  if (toleration.effect && toleration.effect !== taint.effect) return false;
  if (toleration.key && toleration.key !== taint.key) return false;
  if (toleration.operator === 'Exists') return true;
  // An empty key only makes sense with Exists.
  if (!toleration.key) return false;
  return (toleration.value ?? '') === (taint.value ?? '');
}

function matchesRequirement(req: NodeSelectorRequirement, value: string | undefined): boolean {
  const values = req.values ?? [];
  switch (req.operator) {
    case 'In':
      return value !== undefined && values.includes(value);
    case 'NotIn':
      return value === undefined || !values.includes(value);
    case 'Exists':
      return value !== undefined;
    case 'DoesNotExist':
      return value === undefined;
    case 'Gt':
    case 'Lt': {
      const actual = Number(value);
      const bound = Number(values[0]);
      if (value === undefined || !Number.isInteger(actual) || !Number.isInteger(bound)) return false;
      return req.operator === 'Gt' ? actual > bound : actual < bound;
    }
    default:
      return false;
  }
}

function matchesTerm(term: NodeSelectorTerm, node: KubeObject): boolean {
  const labels = node.metadata.labels ?? {};
  const expressions = term.matchExpressions ?? [];
  const fields = term.matchFields ?? [];
  // An empty term selects nothing.
  if (!expressions.length && !fields.length) return false;
  return (
    expressions.every((req) => matchesRequirement(req, req.key ? labels[req.key] : undefined)) &&
    fields.every((req) => matchesRequirement(req, req.key === 'metadata.name' ? node.metadata.name : undefined))
  );
}

function taintText(t: Taint): string {
  return `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`;
}

/**
 * Why a node is not a place for this DaemonSet's pods; empty when it is.
 * Resource shortage is not decided here: the controller still creates the
 * pod and the scheduler refuses it, which shows as a Pending pod.
 */
export function daemonNodeExclusions(node: KubeObject, spec: DaemonPodSpec | undefined): string[] {
  const reasons: string[] = [];
  const labels = node.metadata.labels ?? {};
  const unmatched = Object.entries(spec?.nodeSelector ?? {}).filter(([key, value]) => labels[key] !== value);
  if (unmatched.length) reasons.push(`nodeSelector ${unmatched.map(([k, v]) => `${k}=${v}`).join(', ')} not matched`);
  const terms = spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms && !terms.some((term) => matchesTerm(term, node))) reasons.push('required node affinity not matched');
  const tolerations = [...(spec?.tolerations ?? []), ...defaultTolerations(spec ?? {})];
  const taints = ((node.spec as { taints?: Taint[] } | undefined)?.taints ?? []).filter((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute');
  for (const taint of taints) {
    if (!tolerations.some((tol) => tolerates(tol, taint))) reasons.push(`taint ${taintText(taint)} not tolerated`);
  }
  return reasons;
}

export type NodeCoverageState = 'running' | 'not-ready' | 'pending' | 'missing' | 'excluded' | 'misscheduled';

export interface NodeCoverage {
  node: string;
  state: NodeCoverageState;
  pod?: KubeObject;
  /** Pod status word for nodes with a pod. */
  podStatus?: string;
  /** Scheduler's answer for a pod stuck Pending on this node. */
  issue?: SchedulingIssue;
  /** Why the DaemonSet leaves the node out (excluded / misscheduled). */
  exclusions: string[];
}

const ORDER: Record<NodeCoverageState, number> = { pending: 0, missing: 1, 'not-ready': 2, misscheduled: 3, excluded: 4, running: 5 };

/**
 * One entry per node: running a ready pod, running one that isn't ready,
 * stuck Pending (with the scheduler's reason), eligible with no pod at all,
 * excluded on purpose, or running a pod it shouldn't. Problems sort first.
 */
export function nodeCoverage(nodes: KubeObject[], pods: KubeObject[], spec: DaemonPodSpec | undefined, issues?: Map<string, SchedulingIssue>): NodeCoverage[] {
  const podsByNode = new Map<string, KubeObject>();
  for (const pod of pods) {
    const node = (pod.spec as { nodeName?: string } | undefined)?.nodeName ?? pinnedNode(pod);
    if (!node) continue;
    // Prefer a live pod over one on its way out during a rolling update.
    const prev = podsByNode.get(node);
    if (!prev || (prev.metadata.deletionTimestamp && !pod.metadata.deletionTimestamp)) podsByNode.set(node, pod);
  }
  const out: NodeCoverage[] = nodes.map((node) => {
    const name = node.metadata.name;
    const exclusions = daemonNodeExclusions(node, spec);
    const pod = podsByNode.get(name);
    if (!pod) return { node: name, state: exclusions.length ? 'excluded' : 'missing', exclusions };
    const summary = podSummary(pod);
    if (exclusions.length) return { node: name, state: 'misscheduled', pod, podStatus: summary.status, exclusions };
    const issue = issues ? issues.get(pod.metadata.uid) : podSchedulingIssue(pod);
    if (issue) return { node: name, state: 'pending', pod, podStatus: summary.status, issue, exclusions };
    const [ready, total] = summary.ready.split('/');
    const isReady = summary.status === 'Running' && ready === total && total !== '0';
    return { node: name, state: isReady ? 'running' : 'not-ready', pod, podStatus: summary.status, exclusions };
  });
  return out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || naturalCompare(a.node, b.node));
}
