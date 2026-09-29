import type { InventoryHealth, KubeObject, OverviewWorkloadIssue } from '@kubus/shared';
import { readiness, type ReadinessCheck } from './operator-rollups.js';
import { podFailure } from './overview.js';
import { HEALTH_KINDS } from './workload-health.js';

/**
 * Health splits behind the namespace inventory's bars. Kinds covered by the
 * unified checkers in workload-health.ts keep their verdicts (an object with
 * no issue is healthy) and only get each issue graded; pods, ReplicaSets and
 * the popular custom resources get small checks of their own here.
 */

export type HealthGrade = 'healthy' | 'degraded' | 'failed';

type CustomCheck = ReadinessCheck | 'route-parents';

/** Popular CRDs (`<plural>.<group>`) with a status worth a health bar. */
const CUSTOM_CHECKS: Record<string, CustomCheck> = {
  'certificates.cert-manager.io': 'ready-condition',
  'issuers.cert-manager.io': 'ready-condition',
  'applications.argoproj.io': 'argo-app',
  'rollouts.argoproj.io': 'argo-rollout',
  'kustomizations.kustomize.toolkit.fluxcd.io': 'ready-condition',
  'helmreleases.helm.toolkit.fluxcd.io': 'ready-condition',
  'gitrepositories.source.toolkit.fluxcd.io': 'ready-condition',
  'scaledobjects.keda.sh': 'ready-condition',
  'externalsecrets.external-secrets.io': 'ready-condition',
  'httproutes.gateway.networking.k8s.io': 'route-parents',
};

const CHECKED_KINDS = new Set(HEALTH_KINDS.map((k) => k.kind));

interface Condition {
  type?: string;
  status?: string;
}

function tally(grades: Iterable<HealthGrade>): InventoryHealth {
  const health: InventoryHealth = { healthy: 0, degraded: 0, failed: 0 };
  for (const grade of grades) health[grade] += 1;
  return health;
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

/** Split a kind's objects by the checker issues raised against them. */
export function healthFromIssues(total: number, issues: OverviewWorkloadIssue[]): InventoryHealth {
  const health = tally(issues.map(issueGrade));
  health.healthy = Math.max(0, total - health.degraded - health.failed);
  return health;
}

/** Failing pods (the overview's definition) are failed; running-but-unready and young Pending pods are degraded. */
export function podGrade(pod: KubeObject, now: number): HealthGrade {
  if (podFailure(pod, now)) return 'failed';
  const status = pod.status as { phase?: string; conditions?: Condition[] } | undefined;
  if (status?.phase === 'Succeeded') return 'healthy';
  if (status?.phase === 'Running' && (status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')) return 'healthy';
  return 'degraded';
}

/** Same rule as the Deployment checker; scaled-down (old revision) ReplicaSets are healthy. */
export function replicaSetGrade(rs: KubeObject): HealthGrade {
  const desired = (rs.spec as { replicas?: number } | undefined)?.replicas ?? 1;
  if (desired === 0) return 'healthy';
  const available = (rs.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0;
  if (available >= desired) return 'healthy';
  return available === 0 ? 'failed' : 'degraded';
}

/**
 * Operator CRs keep the rollup's readiness verdict (no status yet is not a
 * failure); a not-ready object is failed when its controller says so
 * outright and degraded while it is still converging.
 */
export function customResourceGrade(check: CustomCheck, obj: KubeObject): HealthGrade {
  if (check === 'route-parents') {
    const parents = (obj.status as { parents?: Array<{ conditions?: Condition[] }> } | undefined)?.parents ?? [];
    const conditions = parents.flatMap((p) => p.conditions ?? []);
    if (conditions.some((c) => (c.type === 'Accepted' || c.type === 'ResolvedRefs') && c.status === 'False')) return 'failed';
    return conditions.some((c) => c.status === 'Unknown') ? 'degraded' : 'healthy';
  }
  if (readiness(check, obj).ready) return 'healthy';
  if (check === 'argo-app') {
    const health = (obj.status as { health?: { status?: string } } | undefined)?.health?.status;
    return health === 'Degraded' || health === 'Missing' ? 'failed' : 'degraded';
  }
  if (check === 'argo-rollout') {
    return (obj.status as { phase?: string } | undefined)?.phase === 'Degraded' ? 'failed' : 'degraded';
  }
  const ready = ((obj.status as { conditions?: Condition[] } | undefined)?.conditions ?? []).find((c) => c.type === 'Ready');
  return ready?.status === 'False' ? 'failed' : 'degraded';
}

/**
 * Health split for one builtin inventory kind, or undefined when the kind
 * has no notion of health (ConfigMaps, Services, RBAC…). `issues` are the
 * workload-health issues for this kind.
 */
export function builtinInventoryHealth(kind: string, items: KubeObject[], issues: OverviewWorkloadIssue[], now: number): InventoryHealth | undefined {
  if (kind === 'Pod') return tally(items.map((pod) => podGrade(pod, now)));
  if (kind === 'ReplicaSet') return tally(items.map(replicaSetGrade));
  if (CHECKED_KINDS.has(kind)) return healthFromIssues(items.length, issues);
  return undefined;
}

/** Health split for an installed popular CRD, by its `<plural>.<group>` name. */
export function customInventoryHealth(crdName: string, items: KubeObject[]): InventoryHealth | undefined {
  const check = CUSTOM_CHECKS[crdName];
  return check ? tally(items.map((obj) => customResourceGrade(check, obj))) : undefined;
}
