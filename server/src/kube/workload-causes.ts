import type { KubeObject, OverviewWorkloadIssue, WorkloadIssueCause } from '@kubus/shared';

/**
 * Why an unhealthy workload is unhealthy, in concrete terms: "Unavailable
 * 0/2" says nothing a user can act on, the pods' ImagePullBackOff or the
 * controller's FailedCreate does. Read from the pods and events the
 * overview already holds, so no extra API calls.
 */

interface ContainerStatus {
  name: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; message?: string; exitCode?: number };
    running?: unknown;
  };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
}

interface PodStatus {
  phase?: string;
  reason?: string;
  message?: string;
  conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  initContainerStatuses?: ContainerStatus[];
  containerStatuses?: ContainerStatus[];
}

interface EventShape {
  type?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string;
  eventTime?: string;
  firstTimestamp?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
}

/** Waiting states that are part of a normal start, not a problem. */
const BENIGN_WAITING = new Set(['ContainerCreating', 'PodInitializing']);
const PULL_REASONS = new Set(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImageNeverPull']);
/** Warnings older than this are history, not the current cause. */
const OBJECT_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Lower ranks win when a workload's pods disagree: a crash beats a slow probe. */
function rank(reason: string): number {
  if (reason === 'CrashLoopBackOff' || PULL_REASONS.has(reason) || reason.startsWith('CreateContainer') || reason === 'RunContainerError') return 0;
  if (reason === 'Unschedulable') return 1;
  if (reason === 'NotReady') return 3;
  return 2;
}

function eventTime(e: EventShape & KubeObject): string {
  return e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp ?? '';
}

/** Warning events by `namespace/kind/name`, newest first. */
function indexWarnings(events: KubeObject[], now: number): Map<string, Array<{ reason: string; message: string; time: string; kind: string; name: string }>> {
  const byObject = new Map<string, Array<{ reason: string; message: string; time: string; kind: string; name: string }>>();
  for (const raw of events) {
    const e = raw as KubeObject & EventShape;
    if (e.type !== 'Warning' || !e.involvedObject?.kind || !e.involvedObject.name) continue;
    const time = eventTime(e);
    const t = Date.parse(time);
    if (Number.isNaN(t) || now - t > OBJECT_EVENT_WINDOW_MS) continue;
    const namespace = e.involvedObject.namespace ?? e.metadata.namespace ?? '';
    const key = `${namespace}/${e.involvedObject.kind}/${e.involvedObject.name}`;
    const list = byObject.get(key) ?? [];
    list.push({ reason: e.reason ?? '', message: e.message ?? '', time, kind: e.involvedObject.kind, name: e.involvedObject.name });
    byObject.set(key, list);
  }
  for (const list of byObject.values()) list.sort((a, b) => b.time.localeCompare(a.time));
  return byObject;
}

/**
 * The workload a pod belongs to as `Kind/name`: its controller owner, with a
 * ReplicaSet owner resolved to its Deployment through the pod-template-hash
 * suffix the Deployment controller names ReplicaSets with.
 */
export function podWorkload(pod: KubeObject): string | undefined {
  const owners = pod.metadata.ownerReferences ?? [];
  const owner = owners.find((o) => o.controller) ?? owners[0];
  if (!owner) return undefined;
  if (owner.kind === 'ReplicaSet') {
    const hash = pod.metadata.labels?.['pod-template-hash'];
    if (hash && owner.name.endsWith(`-${hash}`)) return `Deployment/${owner.name.slice(0, -(hash.length + 1))}`;
    return `ReplicaSet/${owner.name}`;
  }
  return `${owner.kind}/${owner.name}`;
}

/** The pod's own problem, if it has one. */
export function podCause(pod: KubeObject, warnings?: Array<{ reason: string; message: string }>): WorkloadIssueCause | undefined {
  const status = pod.status as PodStatus | undefined;
  const source = { kind: 'Pod', name: pod.metadata.name };
  const containers = [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])];
  const restarts = (status?.containerStatuses ?? []).reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  for (const c of containers) {
    const waiting = c.state?.waiting;
    if (!waiting?.reason || BENIGN_WAITING.has(waiting.reason)) continue;
    return {
      reason: waiting.reason,
      message: waiting.message,
      source,
      restarts,
      exitCode: c.lastState?.terminated?.exitCode,
      image: PULL_REASONS.has(waiting.reason) ? c.image : undefined,
    };
  }
  // Between two back-off waits a crash-looping container sits in a failed
  // terminated state; name it by the loop, not the instant, so the reason
  // doesn't flip between polls.
  for (const c of containers) {
    const terminated = c.state?.terminated;
    if (!terminated || (terminated.exitCode ?? 0) === 0 || status?.phase === 'Failed') continue;
    return {
      reason: (c.restartCount ?? 0) > 0 ? 'CrashLoopBackOff' : (terminated.reason ?? 'Error'),
      message: terminated.message,
      source,
      restarts,
      exitCode: terminated.exitCode,
    };
  }
  if (status?.phase === 'Failed') {
    const terminated = containers.find((c) => (c.state?.terminated?.exitCode ?? 0) !== 0)?.state?.terminated;
    return { reason: status.reason ?? terminated?.reason ?? 'Failed', message: status.message ?? terminated?.message, source, restarts, exitCode: terminated?.exitCode };
  }
  if (status?.phase === 'Pending') {
    const scheduled = status.conditions?.find((c) => c.type === 'PodScheduled');
    if (scheduled?.status === 'False') {
      const event = warnings?.find((w) => w.reason === 'FailedScheduling');
      return { reason: scheduled.reason ?? 'Unschedulable', message: scheduled.message || event?.message, source };
    }
  }
  if (status?.phase === 'Running' && containers.some((c) => c.ready === false && c.state?.running)) {
    const probe = warnings?.find((w) => w.reason === 'Unhealthy');
    return { reason: 'NotReady', message: probe?.message, source, restarts };
  }
  return undefined;
}

/** Kinds whose pods carry the explanation. */
const POD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job']);
/** Kinds whose own events carry it (volume provisioning). */
const EVENT_KINDS = new Set(['PersistentVolumeClaim']);

/**
 * Attach a `cause` to each issue that has a concrete one. `pods` and
 * `events` must cover the issues' namespaces; anything outside is ignored.
 */
export function attachWorkloadCauses(
  issues: OverviewWorkloadIssue[],
  pods: KubeObject[],
  events: KubeObject[],
  now = Date.now(),
): OverviewWorkloadIssue[] {
  const wanted = issues.filter((i) => POD_KINDS.has(i.kind) || EVENT_KINDS.has(i.kind));
  if (wanted.length === 0) return issues;
  const warnings = indexWarnings(events, now);
  const podsByWorkload = new Map<string, KubeObject[]>();
  for (const pod of pods) {
    const workload = podWorkload(pod);
    if (!workload) continue;
    const key = `${pod.metadata.namespace ?? ''}/${workload}`;
    const list = podsByWorkload.get(key) ?? [];
    list.push(pod);
    podsByWorkload.set(key, list);
  }

  const causeFor = (issue: OverviewWorkloadIssue): WorkloadIssueCause | undefined => {
    if (POD_KINDS.has(issue.kind)) {
      const owned = podsByWorkload.get(`${issue.namespace}/${issue.kind}/${issue.name}`) ?? [];
      const causes = owned.flatMap((pod) => {
        const cause = podCause(pod, warnings.get(`${pod.metadata.namespace ?? ''}/Pod/${pod.metadata.name}`));
        return cause ? [cause] : [];
      });
      if (causes.length) {
        // Stable choice: the most severe reason, then the first pod by name.
        causes.sort((a, b) => rank(a.reason) - rank(b.reason) || (a.source?.name ?? '').localeCompare(b.source?.name ?? ''));
        const first = causes[0]!;
        return { ...first, pods: causes.filter((c) => c.reason === first.reason).length };
      }
    }
    // No pod explains it: the controller could not create any (quota,
    // admission), or it is a volume the provisioner refused.
    const own = warnings.get(`${issue.namespace}/${issue.kind}/${issue.name}`)?.[0];
    const replicaSets =
      issue.kind === 'Deployment'
        ? [...warnings.entries()]
            .filter(([key]) => key.startsWith(`${issue.namespace}/ReplicaSet/${issue.name}-`))
            .flatMap(([, list]) => list.slice(0, 1))
            .sort((a, b) => b.time.localeCompare(a.time))
        : [];
    const event = [own, replicaSets[0]].filter((e) => !!e).sort((a, b) => b.time.localeCompare(a.time))[0];
    return event ? { reason: event.reason, message: event.message, source: { kind: event.kind, name: event.name } } : undefined;
  };

  return issues.map((issue) => {
    if (!POD_KINDS.has(issue.kind) && !EVENT_KINDS.has(issue.kind)) return issue;
    const cause = causeFor(issue);
    return cause ? { ...issue, cause } : issue;
  });
}
