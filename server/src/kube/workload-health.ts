import type { KubeObject, OverviewKindHealth, OverviewWorkloadIssue } from '@kubus/shared';
import { parseQuantity } from './quantity.js';

/**
 * Unified health checks across workload, autoscaling, storage, and policy
 * kinds. Consumed by both the cluster overview and the namespace overview so
 * "unhealthy" means the same thing everywhere.
 */

export interface HealthKindSpec {
  kind: string;
  group: string;
  version: string;
  plural: string;
}

/** Kinds the unified health section covers, in display order. */
export const HEALTH_KINDS: HealthKindSpec[] = [
  { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments' },
  { kind: 'StatefulSet', group: 'apps', version: 'v1', plural: 'statefulsets' },
  { kind: 'DaemonSet', group: 'apps', version: 'v1', plural: 'daemonsets' },
  { kind: 'Job', group: 'batch', version: 'v1', plural: 'jobs' },
  { kind: 'CronJob', group: 'batch', version: 'v1', plural: 'cronjobs' },
  { kind: 'HorizontalPodAutoscaler', group: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers' },
  { kind: 'PersistentVolumeClaim', group: '', version: 'v1', plural: 'persistentvolumeclaims' },
  { kind: 'PodDisruptionBudget', group: 'policy', version: 'v1', plural: 'poddisruptionbudgets' },
  { kind: 'ResourceQuota', group: '', version: 'v1', plural: 'resourcequotas' },
];

export interface HealthKindItems {
  spec: HealthKindSpec;
  items: KubeObject[];
  unavailable: boolean;
}

export interface WorkloadHealthResult {
  kinds: OverviewKindHealth[];
  issues: OverviewWorkloadIssue[];
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

function conditions(obj: KubeObject): Condition[] {
  return (obj.status as { conditions?: Condition[] } | undefined)?.conditions ?? [];
}

function issueBase(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue {
  return { kind: spec.kind, namespace: obj.metadata.namespace ?? '', name: obj.metadata.name };
}

/**
 * Latest Job per owning CronJob (`namespace/name` key) — CronJob health is
 * "did the most recent run fail".
 */
export function latestJobsByCronJob(jobs: KubeObject[]): Map<string, KubeObject> {
  const latest = new Map<string, KubeObject>();
  for (const job of jobs) {
    const owner = (job.metadata.ownerReferences ?? []).find((o) => o.kind === 'CronJob');
    if (!owner) continue;
    const key = `${job.metadata.namespace ?? ''}/${owner.name}`;
    const prev = latest.get(key);
    if (!prev || (job.metadata.creationTimestamp ?? '').localeCompare(prev.metadata.creationTimestamp ?? '') > 0) {
      latest.set(key, job);
    }
  }
  return latest;
}

function jobFailure(job: KubeObject): Condition | undefined {
  return conditions(job).find((c) => c.type === 'Failed' && c.status === 'True');
}

function checkDeployment(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const desired = (obj.spec as { replicas?: number } | undefined)?.replicas ?? 1;
  const ready = (obj.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0;
  if (desired > 0 && ready < desired) return { ...issueBase(spec, obj), ready, desired, reason: 'Unavailable' };
  return undefined;
}

function checkStatefulSet(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const desired = (obj.spec as { replicas?: number } | undefined)?.replicas ?? 1;
  const ready = (obj.status as { readyReplicas?: number } | undefined)?.readyReplicas ?? 0;
  if (desired > 0 && ready < desired) return { ...issueBase(spec, obj), ready, desired, reason: 'Unavailable' };
  return undefined;
}

function checkDaemonSet(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const status = obj.status as { desiredNumberScheduled?: number; numberReady?: number } | undefined;
  const desired = status?.desiredNumberScheduled ?? 0;
  const ready = status?.numberReady ?? 0;
  if (desired > 0 && ready < desired) return { ...issueBase(spec, obj), ready, desired, reason: 'Unavailable' };
  return undefined;
}

function checkJob(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const failed = jobFailure(obj);
  if (!failed) return undefined;
  const desired = (obj.spec as { completions?: number } | undefined)?.completions ?? 1;
  const ready = (obj.status as { succeeded?: number } | undefined)?.succeeded ?? 0;
  return { ...issueBase(spec, obj), ready, desired, reason: failed.reason ?? 'Failed', message: failed.message };
}

function checkCronJob(spec: HealthKindSpec, obj: KubeObject, latestJobs: Map<string, KubeObject>): OverviewWorkloadIssue | undefined {
  if ((obj.spec as { suspend?: boolean } | undefined)?.suspend) return undefined;
  const latest = latestJobs.get(`${obj.metadata.namespace ?? ''}/${obj.metadata.name}`);
  const failed = latest && jobFailure(latest);
  if (!failed) return undefined;
  return { ...issueBase(spec, obj), reason: 'LastRunFailed', message: failed.message ?? `Job ${latest.metadata.name} failed` };
}

function checkHpa(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const bad = conditions(obj).find(
    (c) => (c.type === 'AbleToScale' || c.type === 'ScalingActive') && c.status === 'False' && c.reason !== 'ScalingDisabled',
  );
  if (!bad) return undefined;
  const status = obj.status as { currentReplicas?: number; desiredReplicas?: number } | undefined;
  return {
    ...issueBase(spec, obj),
    ready: status?.currentReplicas,
    desired: status?.desiredReplicas,
    reason: bad.reason ?? bad.type,
    message: bad.message,
  };
}

function checkPvc(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const phase = (obj.status as { phase?: string } | undefined)?.phase;
  if (phase === 'Bound') return undefined;
  return { ...issueBase(spec, obj), reason: phase ?? 'Pending' };
}

function checkPdb(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const status = obj.status as { expectedPods?: number; disruptionsAllowed?: number; currentHealthy?: number; desiredHealthy?: number } | undefined;
  if ((status?.expectedPods ?? 0) > 0 && (status?.disruptionsAllowed ?? 0) === 0) {
    return {
      ...issueBase(spec, obj),
      ready: status?.currentHealthy,
      desired: status?.desiredHealthy,
      reason: 'NoDisruptionsAllowed',
      message: 'Voluntary evictions are blocked — a node drain would hang on this budget.',
    };
  }
  return undefined;
}

function checkQuota(spec: HealthKindSpec, obj: KubeObject): OverviewWorkloadIssue | undefined {
  const status = obj.status as { hard?: Record<string, string>; used?: Record<string, string> } | undefined;
  const at: string[] = [];
  const near: string[] = [];
  for (const [resource, hard] of Object.entries(status?.hard ?? {})) {
    const hardVal = parseQuantity(hard);
    if (hardVal <= 0) continue;
    const used = parseQuantity(status?.used?.[resource]);
    if (used >= hardVal) at.push(`${resource} ${status?.used?.[resource] ?? '0'}/${hard}`);
    else if (used >= hardVal * 0.9) near.push(`${resource} ${status?.used?.[resource] ?? '0'}/${hard}`);
  }
  if (at.length === 0 && near.length === 0) return undefined;
  return {
    ...issueBase(spec, obj),
    reason: at.length > 0 ? 'AtQuota' : 'NearQuota',
    message: [...at, ...near].join(', '),
  };
}

/**
 * Per-kind totals + unified issue list. Items must be pre-filtered to the
 * namespace of interest by the caller (or cluster-wide for the overview).
 */
export function computeWorkloadHealth(kinds: HealthKindItems[]): WorkloadHealthResult {
  const jobs = kinds.find((k) => k.spec.kind === 'Job')?.items ?? [];
  const latestJobs = latestJobsByCronJob(jobs);
  const result: WorkloadHealthResult = { kinds: [], issues: [] };
  for (const { spec, items, unavailable } of kinds) {
    let unhealthy = 0;
    for (const obj of items) {
      let issue: OverviewWorkloadIssue | undefined;
      switch (spec.kind) {
        case 'Deployment':
          issue = checkDeployment(spec, obj);
          break;
        case 'StatefulSet':
          issue = checkStatefulSet(spec, obj);
          break;
        case 'DaemonSet':
          issue = checkDaemonSet(spec, obj);
          break;
        case 'Job':
          issue = checkJob(spec, obj);
          break;
        case 'CronJob':
          issue = checkCronJob(spec, obj, latestJobs);
          break;
        case 'HorizontalPodAutoscaler':
          issue = checkHpa(spec, obj);
          break;
        case 'PersistentVolumeClaim':
          issue = checkPvc(spec, obj);
          break;
        case 'PodDisruptionBudget':
          issue = checkPdb(spec, obj);
          break;
        case 'ResourceQuota':
          issue = checkQuota(spec, obj);
          break;
      }
      if (issue) {
        unhealthy += 1;
        result.issues.push(issue);
      }
    }
    result.kinds.push({
      kind: spec.kind,
      group: spec.group,
      version: spec.version,
      plural: spec.plural,
      total: items.length,
      unhealthy,
      unavailable: unavailable || undefined,
    });
  }
  result.issues.sort((a, b) => `${a.kind}/${a.namespace}/${a.name}`.localeCompare(`${b.kind}/${b.namespace}/${b.name}`));
  return result;
}
