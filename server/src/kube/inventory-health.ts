import type { InventoryHealth, InventoryProblem, KubeObject, OverviewWorkloadIssue } from '@kubus/shared';
import { operatorCheckFor, readiness } from './operator-rollups.js';
import { podFailure } from './overview.js';
import { HEALTH_KINDS } from './workload-health.js';

/**
 * Health splits behind the namespace inventory's bars, and the objects
 * behind every degraded or failed part. Kinds covered by the unified
 * checkers in workload-health.ts keep their verdicts (an object with no
 * issue is healthy) and only get each issue graded; pods and ReplicaSets
 * get small checks of their own; custom resources use the operator
 * rollups' readiness checks.
 */

export type HealthGrade = 'healthy' | 'degraded' | 'failed';

export interface KindRef {
  kind: string;
  group: string;
  version: string;
  plural: string;
}

/** A kind's health split plus one problem per degraded or failed object. */
export interface GradedKind {
  health: InventoryHealth;
  problems: InventoryProblem[];
}

type Verdict = { grade: 'healthy' } | ({ grade: 'degraded' | 'failed' } & Pick<InventoryProblem, 'reason' | 'message' | 'ready' | 'desired' | 'restarts'>);

const HEALTHY: Verdict = { grade: 'healthy' };

const CHECKED_KINDS = new Set(HEALTH_KINDS.map((k) => k.kind));

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface ContainerState {
  state?: { waiting?: { reason?: string; message?: string } };
}

function graded(spec: KindRef, items: KubeObject[], verdict: (obj: KubeObject) => Verdict, custom?: boolean): GradedKind {
  // Callers pass richer specs (nav entries, resolved CRDs); keep only the GVK.
  const ref: KindRef = { kind: spec.kind, group: spec.group, version: spec.version, plural: spec.plural };
  const health: InventoryHealth = { healthy: 0, degraded: 0, failed: 0 };
  const problems: InventoryProblem[] = [];
  for (const obj of items) {
    const v = verdict(obj);
    health[v.grade] += 1;
    if (v.grade === 'healthy') continue;
    const { grade, ...detail } = v;
    problems.push({ ...ref, namespace: obj.metadata.namespace ?? '', name: obj.metadata.name, grade, ...detail, ...(custom ? { custom } : {}) });
  }
  problems.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  return { health, problems };
}

/** Nothing working is failed; anything short of that is degraded. */
export function issueGrade(issue: OverviewWorkloadIssue): 'degraded' | 'failed' {
  switch (issue.kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
      return (issue.ready ?? 0) === 0 ? 'failed' : 'degraded';
    case 'Job':
    case 'CronJob':
      return 'failed';
    case 'PersistentVolumeClaim':
      return issue.reason === 'Lost' ? 'failed' : 'degraded';
    case 'ResourceQuota':
      return issue.reason === 'AtQuota' ? 'failed' : 'degraded';
    default:
      // An HPA that cannot scale or a PDB that blocks evictions leaves the
      // workload itself running.
      return 'degraded';
  }
}

/** Why a pod that is not failing is still not ready: a waiting container, scheduling, or readiness. */
function podNotReady(pod: KubeObject): { reason: string; message?: string } {
  const status = pod.status as { phase?: string; message?: string; conditions?: Condition[]; initContainerStatuses?: ContainerState[]; containerStatuses?: ContainerState[] } | undefined;
  const waiting = [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])].map((c) => c.state?.waiting).find((w) => w?.reason);
  if (waiting?.reason) return { reason: waiting.reason, message: waiting.message };
  const conditions = status?.conditions ?? [];
  const unscheduled = conditions.find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (unscheduled) return { reason: unscheduled.reason ?? 'Unschedulable', message: unscheduled.message };
  if (status?.phase === 'Running') return { reason: 'NotReady', message: conditions.find((c) => c.type === 'Ready')?.message };
  return { reason: status?.phase ?? 'Unknown', message: status?.message };
}

/** Failing pods (the overview's definition) are failed; running-but-unready and young Pending pods are degraded. */
export function podVerdict(pod: KubeObject, now: number): Verdict {
  const failure = podFailure(pod, now);
  if (failure) return { grade: 'failed', reason: failure.reason, message: failure.message, restarts: failure.restarts || undefined };
  const status = pod.status as { phase?: string; conditions?: Condition[] } | undefined;
  if (status?.phase === 'Succeeded') return HEALTHY;
  if (status?.phase === 'Running' && (status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')) return HEALTHY;
  return { grade: 'degraded', ...podNotReady(pod) };
}

/** Same rule as the Deployment checker; scaled-down (old revision) ReplicaSets are healthy. */
export function replicaSetVerdict(rs: KubeObject): Verdict {
  const desired = (rs.spec as { replicas?: number } | undefined)?.replicas ?? 1;
  if (desired === 0) return HEALTHY;
  const available = (rs.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0;
  if (available >= desired) return HEALTHY;
  return { grade: available === 0 ? 'failed' : 'degraded', reason: 'Unavailable', ready: available, desired };
}

/**
 * Health and problems for one builtin inventory kind, or undefined when the
 * kind has no notion of health (ConfigMaps, Services, RBAC…). `issues` are
 * the workload-health issues for this kind.
 */
export function gradeBuiltinKind(spec: KindRef, items: KubeObject[], issues: OverviewWorkloadIssue[], now: number): GradedKind | undefined {
  if (spec.kind === 'Pod') return graded(spec, items, (pod) => podVerdict(pod, now));
  if (spec.kind === 'ReplicaSet') return graded(spec, items, replicaSetVerdict);
  if (!CHECKED_KINDS.has(spec.kind)) return undefined;
  const byObject = new Map(issues.map((i) => [`${i.namespace}/${i.name}`, i]));
  return graded(spec, items, (obj) => {
    const issue = byObject.get(`${obj.metadata.namespace ?? ''}/${obj.metadata.name}`);
    if (!issue) return HEALTHY;
    return { grade: issueGrade(issue), reason: issue.reason ?? 'Unhealthy', message: issue.message, ready: issue.ready, desired: issue.desired };
  });
}

/**
 * Health and problems for an installed popular CRD (`<plural>.<group>`),
 * graded with the same readiness check its operator rollup uses: not ready
 * and still converging is degraded, refused outright is failed. Undefined
 * for CRDs without a known status shape.
 */
export function gradeCustomKind(crdName: string, spec: KindRef, items: KubeObject[]): GradedKind | undefined {
  const check = operatorCheckFor(crdName);
  if (!check) return undefined;
  return graded(
    spec,
    items,
    (obj) => {
      const r = readiness(check, obj);
      if (r.ready) return HEALTHY;
      return { grade: r.pending ? 'degraded' : 'failed', reason: r.reason ?? 'NotReady', message: r.message };
    },
    true,
  );
}
