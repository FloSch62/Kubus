import type { KubernetesObject } from '@kubernetes/client-node';
import type { HelmResourceValidation } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { docLabel, pathForDoc, validateDoc } from './common.js';

const POLL_MS = 2_000;
const CRASH_LOOP_GRACE_MS = 90_000;
const READ_ERROR_GRACE_MS = 60_000;
const WAIT_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'Pod', 'PersistentVolumeClaim']);
const POD_WARNING_REASONS = new Set(['FailedAttachVolume', 'FailedMount', 'FailedScheduling', 'FailedCreatePodSandBox']);
const MULTI_ATTACH_RE = /multi-attach|already used by pod|already exclusively attached|can't be attached to another/i;

interface LiveObject {
  metadata?: {
    generation?: number;
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }>;
  };
  spec?: {
    replicas?: number;
    paused?: boolean;
    strategy?: DeploymentStrategy;
    updateStrategy?: {
      type?: string;
      rollingUpdate?: { partition?: number };
    };
    selector?: {
      matchLabels?: Record<string, string>;
      matchExpressions?: Array<{ key?: string; operator?: string; values?: string[] }>;
    };
  };
  status?: {
    observedGeneration?: number;
    readyReplicas?: number;
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    currentReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    updatedNumberScheduled?: number;
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

interface DeploymentStrategy {
  type?: string;
  rollingUpdate?: {
    maxSurge?: number | string;
    maxUnavailable?: number | string;
  };
}

interface DeploymentDoc extends KubernetesObject {
  spec?: {
    replicas?: number;
    strategy?: DeploymentStrategy;
    template?: {
      spec?: {
        volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }>;
      };
    };
  };
}

interface PersistentVolumeClaimDoc extends KubernetesObject {
  spec?: { accessModes?: string[] };
}

interface ContainerStatus {
  name?: string;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { exitCode?: number; reason?: string; message?: string };
  };
}

interface ReadinessState {
  ready: boolean;
  failed?: boolean;
  /** The state could not be read (API hiccup) — grace-tracked, not an instant failure. */
  transientError?: boolean;
  message: string;
}

interface PodEvent {
  metadata?: { creationTimestamp?: string };
  involvedObject?: { kind?: string; name?: string; uid?: string };
  type?: string;
  reason?: string;
  message?: string;
  eventTime?: string;
  lastTimestamp?: string;
  series?: { lastObservedTime?: string };
}

interface PodDiagnostic {
  message: string;
  multiAttach: boolean;
  crashLoop: boolean;
}

interface WorkloadDiagnostic extends PodDiagnostic {
  identity: string;
}

export interface ReadinessIssue {
  resource: string;
  message: string;
}

export interface ReadinessProgress {
  ready: number;
  total: number;
  pending: ReadinessIssue[];
  recovering: ReadinessIssue[];
}

export interface ReadinessOptions {
  /**
   * A one-replica RollingUpdate can deadlock when its old and new pods land on
   * different nodes while mounting the same ReadWriteOnce volume. Once the
   * API server reports that exact multi-attach failure, temporarily use
   * Recreate and restore the manifest's strategy after the pod is ready.
   */
  recoverMultiAttach?: boolean;
}

export class HelmReadinessError extends Error {
  constructor(
    message: string,
    public issues: ReadinessIssue[],
  ) {
    super(message);
  }
}

function condition(object: LiveObject, type: string, status = 'True') {
  return object.status?.conditions?.find((item) => item.type === type && item.status === status);
}

export function workloadState(kind: string, object: LiveObject): ReadinessState {
  const status = object.status ?? {};
  if (kind === 'Deployment') {
    // A paused deployment never progresses and never sets
    // ProgressDeadlineExceeded — waiting on it would burn the whole timeout.
    if (object.spec?.paused) {
      return { ready: false, failed: true, message: 'deployment is paused (spec.paused) and cannot roll out; resume it and retry' };
    }
    const failed = condition(object, 'Progressing', 'False');
    if (failed?.reason === 'ProgressDeadlineExceeded') {
      return { ready: false, failed: true, message: failed.message ?? 'deployment exceeded its progress deadline' };
    }
    const desired = object.spec?.replicas ?? 1;
    const observed = (status.observedGeneration ?? 0) >= (object.metadata?.generation ?? 0);
    // replicas===desired matters during rolling updates: otherwise an old
    // available pod plus a new-but-unready pod can satisfy the aggregate
    // available/updated counters and be reported ready too early.
    const ready =
      observed &&
      (status.updatedReplicas ?? 0) >= desired &&
      (status.availableReplicas ?? 0) >= desired &&
      (status.readyReplicas ?? 0) >= desired &&
      (status.replicas ?? 0) === desired;
    return {
      ready,
      message: `${status.availableReplicas ?? 0}/${desired} available, ${status.updatedReplicas ?? 0}/${desired} updated, ${
        status.replicas ?? 0
      }/${desired} total`,
    };
  }
  if (kind === 'StatefulSet') {
    const desired = object.spec?.replicas ?? 1;
    const observed = (status.observedGeneration ?? 0) >= (object.metadata?.generation ?? 0);
    const strategy = object.spec?.updateStrategy;
    // With a rolling-update partition only ordinals >= partition update, so
    // updatedReplicas legitimately tops out below desired (helm's waiter does
    // the same arithmetic); OnDelete never updates pods on its own.
    const expectedUpdated = Math.max(desired - (strategy?.rollingUpdate?.partition ?? 0), 0);
    const podsUpdated = strategy?.type === 'OnDelete' || (status.updatedReplicas ?? 0) >= expectedUpdated;
    const ready = observed && podsUpdated && (status.readyReplicas ?? 0) >= desired;
    return { ready, message: `${status.readyReplicas ?? 0}/${desired} replicas ready` };
  }
  if (kind === 'DaemonSet') {
    const desired = status.desiredNumberScheduled ?? 0;
    const observed = (status.observedGeneration ?? 0) >= (object.metadata?.generation ?? 0);
    const ready = observed && (status.updatedNumberScheduled ?? 0) >= desired && (status.numberReady ?? 0) >= desired;
    return { ready, message: `${status.numberReady ?? 0}/${desired} pods ready` };
  }
  if (kind === 'Job') {
    const failed = condition(object, 'Failed');
    if (failed) return { ready: false, failed: true, message: failed.message ?? failed.reason ?? 'job failed' };
    return { ready: !!condition(object, 'Complete'), message: 'job has not completed' };
  }
  if (kind === 'Pod') {
    const problem = podProblem(object);
    if (status.phase === 'Failed') return { ready: false, failed: true, message: problem ?? 'pod failed' };
    if (status.phase === 'Succeeded') return { ready: true, message: 'pod completed' };
    return {
      ready: !!condition(object, 'Ready'),
      message: `pod phase is ${status.phase ?? 'unknown'}${problem ? `; ${problem}` : ''}`,
    };
  }
  if (kind === 'PersistentVolumeClaim') {
    return { ready: status.phase === 'Bound', message: `PVC phase is ${status.phase ?? 'unknown'}` };
  }
  return { ready: true, message: 'ready' };
}

function matchesSelector(labels: Record<string, string> | undefined, workload: LiveObject): boolean {
  const actual = labels ?? {};
  const selector = workload.spec?.selector;
  if (!selector || (!Object.keys(selector.matchLabels ?? {}).length && !selector.matchExpressions?.length)) return false;
  for (const [key, value] of Object.entries(selector?.matchLabels ?? {})) {
    if (actual[key] !== value) return false;
  }
  for (const expression of selector?.matchExpressions ?? []) {
    if (!expression.key || !expression.operator) continue;
    const exists = expression.key in actual;
    const values = expression.values ?? [];
    if (expression.operator === 'In' && (!exists || !values.includes(actual[expression.key]!))) return false;
    if (expression.operator === 'NotIn' && exists && values.includes(actual[expression.key]!)) return false;
    if (expression.operator === 'Exists' && !exists) return false;
    if (expression.operator === 'DoesNotExist' && exists) return false;
  }
  return true;
}

function podProblem(pod: LiveObject): string | undefined {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason && !['ContainerCreating', 'PodInitializing'].includes(waiting.reason)) {
      const detail = waiting.message ? `: ${waiting.message.slice(0, 180)}` : '';
      const restarts = status.restartCount ? ` after ${status.restartCount} restart${status.restartCount === 1 ? '' : 's'}` : '';
      return `${status.name ?? 'container'} is ${waiting.reason}${restarts}${detail}`;
    }
    const terminated = status.state?.terminated;
    if (terminated && (terminated.exitCode ?? 0) !== 0) {
      return `${status.name ?? 'container'} exited ${terminated.exitCode}${terminated.reason ? ` (${terminated.reason})` : ''}`;
    }
  }
  const unschedulable = pod.status?.conditions?.find((item) => item.type === 'PodScheduled' && item.status === 'False');
  if (unschedulable) return unschedulable.message ?? unschedulable.reason ?? 'pod cannot be scheduled';
  return undefined;
}

function podIsCrashLooping(pod: LiveObject): boolean {
  return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].some(
    (status) => status.state?.waiting?.reason === 'CrashLoopBackOff',
  );
}

function eventTime(event: PodEvent): number {
  const value = event.series?.lastObservedTime ?? event.eventTime ?? event.lastTimestamp ?? event.metadata?.creationTimestamp;
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function podEventProblem(pod: LiveObject, events: PodEvent[]): { message: string; multiAttach: boolean } | undefined {
  const podEvents = events
    .filter((event) => {
      if (event.type !== 'Warning' || !event.reason || !POD_WARNING_REASONS.has(event.reason)) return false;
      const involved = event.involvedObject;
      if (involved?.kind !== 'Pod') return false;
      if (pod.metadata?.uid && involved.uid) return pod.metadata.uid === involved.uid;
      return !!pod.metadata?.name && pod.metadata.name === involved?.name;
    })
    .toSorted((left, right) => eventTime(right) - eventTime(left));
  // Prefer the actionable multi-attach event even when a newer generic mount
  // warning was emitted for the same pod.
  const event =
    podEvents.find((candidate) => candidate.reason === 'FailedAttachVolume' && MULTI_ATTACH_RE.test(candidate.message ?? '')) ?? podEvents[0];
  if (!event) return undefined;
  const detail = event.message?.slice(0, 360) ?? 'Kubernetes reported a pod warning';
  return {
    message: `${event.reason}: ${detail}`,
    multiAttach: event.reason === 'FailedAttachVolume' && MULTI_ATTACH_RE.test(detail),
  };
}

function replicaSetRevision(replicaSet: LiveObject): number {
  const value = Number(replicaSet.metadata?.annotations?.['deployment.kubernetes.io/revision']);
  return Number.isFinite(value) ? value : 0;
}

function targetReplicaSetHash(replicaSets: LiveObject[], deploymentName: string | undefined): string | undefined {
  if (!deploymentName) return undefined;
  const target = replicaSets
    .filter((replicaSet) =>
      replicaSet.metadata?.ownerReferences?.some(
        (owner) => owner.kind === 'Deployment' && owner.name === deploymentName && owner.controller !== false,
      ),
    )
    .toSorted((left, right) => replicaSetRevision(right) - replicaSetRevision(left))[0];
  return target?.metadata?.labels?.['pod-template-hash'] ?? target?.spec?.selector?.matchLabels?.['pod-template-hash'];
}

async function workloadPodDiagnostics(
  handle: ClusterHandle,
  docs: KubernetesObject[],
): Promise<Map<string, WorkloadDiagnostic>> {
  const relevant = docs.filter((doc) => ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod'].includes(doc.kind ?? '') && doc.metadata?.namespace);
  const namespaces = [...new Set(relevant.map((doc) => doc.metadata!.namespace!))];
  const entries = await Promise.all(
    namespaces.map(async (namespace) => {
      const [pods, events, replicaSets] = await Promise.all([
        handle.raw
          .json<{ items?: LiveObject[] }>(resourcePath('', 'v1', 'pods', { namespace }))
          .then((list) => list.items ?? [])
          .catch(() => [] as LiveObject[]),
        handle.raw
          .json<{ items?: PodEvent[] }>(
            resourcePath('', 'v1', 'events', {
              namespace,
              query: new URLSearchParams({ fieldSelector: 'involvedObject.kind=Pod,type=Warning' }),
            }),
          )
          .then((list) => list.items ?? [])
          .catch(() => [] as PodEvent[]),
        handle.raw
          .json<{ items?: LiveObject[] }>(resourcePath('apps', 'v1', 'replicasets', { namespace }))
          .then((list) => list.items ?? [])
          .catch(() => [] as LiveObject[]),
      ]);
      return [namespace, { pods, events, replicaSets }] as const;
    }),
  );
  const namespaceData = new Map(entries);
  const problems = new Map<string, WorkloadDiagnostic>();
  for (const doc of relevant) {
    const data = namespaceData.get(doc.metadata!.namespace!);
    const pods = data?.pods ?? [];
    const matchingPods =
      doc.kind === 'Pod'
        ? pods.filter((pod) => pod.metadata?.name === doc.metadata?.name)
        : pods.filter((pod) => matchesSelector(pod.metadata?.labels, doc as LiveObject));
    const targetHash = doc.kind === 'Deployment' ? targetReplicaSetHash(data?.replicaSets ?? [], doc.metadata?.name) : undefined;
    // A Deployment selector also matches old ReplicaSets. Diagnostics and
    // crash-loop decisions must describe the template being rolled out, not a
    // stale pod that the controller will remove once the target is ready.
    const candidates = targetHash
      ? matchingPods.filter((pod) => pod.metadata?.labels?.['pod-template-hash'] === targetHash)
      : matchingPods;
    const diagnostics = candidates
      .map((pod) => {
        const runtimeProblem = podProblem(pod);
        const eventProblem = podEventProblem(pod, data?.events ?? []);
        const details = [runtimeProblem, eventProblem?.message].filter((message): message is string => !!message);
        return details.length
          ? {
              message: `${pod.metadata?.name ?? 'pod'}: ${[...new Set(details)].join('; ')}`,
              multiAttach: eventProblem?.multiAttach ?? false,
              crashLoop: podIsCrashLooping(pod),
            }
          : undefined;
      })
      .filter((diagnostic): diagnostic is PodDiagnostic => !!diagnostic);
    if (diagnostics.length) {
      problems.set(docLabel(doc), {
        message: diagnostics
          .slice(0, 2)
          .map((diagnostic) => diagnostic.message)
          .join('; '),
        multiAttach: diagnostics.some((diagnostic) => diagnostic.multiAttach),
        crashLoop:
          doc.kind === 'Deployment' && !targetHash
            ? candidates.length > 0 && candidates.every((pod) => podIsCrashLooping(pod))
            : diagnostics.some((diagnostic) => diagnostic.crashLoop),
        identity: targetHash ?? candidates.map((pod) => pod.metadata?.uid ?? pod.metadata?.name ?? '').sort().join(','),
      });
    }
  }
  return problems;
}

async function readState(handle: ClusterHandle, doc: KubernetesObject): Promise<{ state: ReadinessState; object?: LiveObject }> {
  try {
    const path = await pathForDoc(handle, doc, false);
    const res = await handle.raw.request(path);
    if (res.status === 404) return { state: { ready: false, message: 'resource does not exist yet' } };
    if (!res.ok) {
      // A 429/500/etcd blip during a multi-minute wait is not a workload
      // failure; the caller grace-tracks these instead of failing instantly.
      return { state: { ready: false, transientError: true, message: `${res.status} ${await res.text().catch(() => '')}`.trim() } };
    }
    const object = (await res.json()) as LiveObject;
    return { state: workloadState(doc.kind ?? '', object), object };
  } catch (err) {
    return { state: { ready: false, transientError: true, message: `could not read state: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

function unavailableReplicas(value: number | string | undefined, desired: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.endsWith('%')) {
    const percentage = Number(value.slice(0, -1));
    return Number.isFinite(percentage) ? Math.floor((desired * percentage) / 100) : 0;
  }
  const absolute = Number(value);
  return Number.isFinite(absolute) ? absolute : 0;
}

function isRecoverableMultiAttachDeadlock(doc: KubernetesObject, object: LiveObject | undefined, diagnostic: WorkloadDiagnostic | undefined): boolean {
  if (doc.kind !== 'Deployment' || !object || !diagnostic?.multiAttach) return false;
  const desired = object.spec?.replicas ?? 1;
  const strategy = object.spec?.strategy;
  const rolling = !strategy?.type || strategy.type === 'RollingUpdate';
  const maxUnavailable = strategy?.rollingUpdate?.maxUnavailable ?? '25%';
  return (
    desired === 1 &&
    rolling &&
    unavailableReplicas(maxUnavailable, desired) === 0 &&
    (object.status?.replicas ?? 0) > desired &&
    (object.status?.availableReplicas ?? 0) >= desired
  );
}

async function patchDeploymentStrategy(handle: ClusterHandle, doc: KubernetesObject, strategy: DeploymentStrategy | undefined): Promise<void> {
  const path = await pathForDoc(handle, doc, false);
  // JSON merge patch retains omitted nested keys. Explicitly remove the
  // RollingUpdate settings when changing type or the API server rejects the
  // otherwise-valid Recreate strategy.
  const strategyPatch = strategy?.type === 'Recreate' ? { ...strategy, rollingUpdate: null } : (strategy ?? null);
  const res = await handle.raw.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { strategy: strategyPatch } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text}`.trim());
  }
}

function manifestStrategy(doc: KubernetesObject): DeploymentStrategy | undefined {
  const strategy = (doc as DeploymentDoc).spec?.strategy;
  return strategy ? structuredClone(strategy) : undefined;
}

function rolloutSafetyWarning(doc: DeploymentDoc, claims: Map<string, PersistentVolumeClaimDoc>): string | undefined {
  if (doc.kind !== 'Deployment') return undefined;
  const desired = doc.spec?.replicas ?? 1;
  const strategy = doc.spec?.strategy;
  const rolling = !strategy?.type || strategy.type === 'RollingUpdate';
  if (desired !== 1 || !rolling || unavailableReplicas(strategy?.rollingUpdate?.maxUnavailable ?? '25%', desired) > 0) return undefined;
  const namespace = doc.metadata?.namespace ?? '';
  const mountedClaims = (doc.spec?.template?.spec?.volumes ?? [])
    .map((volume) => volume.persistentVolumeClaim?.claimName)
    .filter((name): name is string => !!name);
  const rwoClaims = mountedClaims.filter((name) => {
    const accessModes = claims.get(`${namespace}/${name}`)?.spec?.accessModes ?? [];
    return accessModes.includes('ReadWriteOnce') || accessModes.includes('ReadWriteOncePod');
  });
  if (!rwoClaims.length) return undefined;
  return `${docLabel(doc)} mounts ${rwoClaims.map((name) => `ReadWriteOnce PVC ${name}`).join(', ')} with a one-replica rolling strategy. If Kubernetes reports a multi-attach deadlock, Kubus will recreate this workload with brief downtime.`;
}

/** Preflight warnings for rollout strategies that can deadlock on RWO volumes. */
export function rolloutSafetyWarnings(docs: KubernetesObject[]): string[] {
  const claims = new Map(
    docs
      .filter((doc): doc is PersistentVolumeClaimDoc => doc.kind === 'PersistentVolumeClaim')
      .map((doc) => [`${doc.metadata?.namespace ?? ''}/${doc.metadata?.name ?? ''}`, doc]),
  );
  return docs
    .filter((doc): doc is DeploymentDoc => doc.kind === 'Deployment')
    .map((doc) => rolloutSafetyWarning(doc, claims))
    .filter((warning): warning is string => !!warning);
}

/**
 * Wait for workload-bearing resources using the same high-signal readiness
 * fields users see in kubectl. Services and other declarative objects are
 * considered ready once the API accepted them.
 */
export async function waitForResources(
  handle: ClusterHandle,
  docs: KubernetesObject[],
  timeoutSeconds: number,
  onProgress?: (progress: ReadinessProgress) => void,
  options: ReadinessOptions = {},
): Promise<string[]> {
  const waiting = docs.filter((doc) => WAIT_KINDS.has(doc.kind ?? ''));
  if (!waiting.length) return [];
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let pending: ReadinessIssue[] = waiting.map((doc) => ({ resource: docLabel(doc), message: 'checking readiness' }));
  const recovering = new Map<string, { doc: KubernetesObject; originalStrategy: DeploymentStrategy | undefined; issue: ReadinessIssue }>();
  const crashLoopSince = new Map<string, { since: number; identity: string }>();
  const readErrorSince = new Map<string, number>();
  onProgress?.({ ready: 0, total: waiting.length, pending, recovering: [] });

  try {
    while (Date.now() < deadline) {
      const states = await Promise.all(
        waiting.map(async (doc) => {
          const observation = await readState(handle, doc);
          return { doc, ...observation };
        }),
      );

      // Restore the chart's declared strategy as soon as the replacement pod
      // is ready. This keeps the temporary recovery out of Helm history and
      // prevents a live/manifest drift after the operation.
      for (const { doc, state } of states) {
        const resource = docLabel(doc);
        const recovery = recovering.get(resource);
        if (!state.ready || !recovery) continue;
        try {
          await patchDeploymentStrategy(handle, recovery.doc, recovery.originalStrategy);
          recovering.delete(resource);
        } catch (error) {
          const issue = { resource, message: `workload recovered, but its rolling strategy could not be restored: ${error instanceof Error ? error.message : String(error)}` };
          onProgress?.({ ready: waiting.length - 1, total: waiting.length, pending: [issue], recovering: [] });
          throw new HelmReadinessError(`${issue.resource}: ${issue.message}`, [issue]);
        }
      }

      // Transient read errors only fail the operation once they persist.
      const escalatedReadErrors: ReadinessIssue[] = [];
      for (const { doc, state } of states) {
        const resource = docLabel(doc);
        if (!state.transientError) {
          readErrorSince.delete(resource);
          continue;
        }
        const since = readErrorSince.get(resource) ?? Date.now();
        readErrorSince.set(resource, since);
        if (Date.now() - since >= READ_ERROR_GRACE_MS) {
          escalatedReadErrors.push({ resource, message: `state could not be read for ${Math.round(READ_ERROR_GRACE_MS / 1_000)}s: ${state.message}` });
        }
      }

      const failed = states.filter(({ state }) => state.failed);
      if (failed.length || escalatedReadErrors.length) {
        const issues = [...failed.map(({ doc, state }) => ({ resource: docLabel(doc), message: state.message })), ...escalatedReadErrors];
        onProgress?.({ ready: waiting.length - issues.length, total: waiting.length, pending: issues, recovering: [...recovering.values()].map((item) => item.issue) });
        throw new HelmReadinessError(`Workload failed: ${issues.map((issue) => `${issue.resource}: ${issue.message}`).join('; ')}`, issues);
      }

      const pendingStates = states.filter(({ state }) => !state.ready);
      const podDiagnostics = await workloadPodDiagnostics(
        handle,
        pendingStates.map(({ doc }) => doc),
      );

      const now = Date.now();
      const persistentCrashLoops: ReadinessIssue[] = [];
      for (const { doc } of pendingStates) {
        const resource = docLabel(doc);
        const diagnostic = podDiagnostics.get(resource);
        if (!diagnostic?.crashLoop) {
          crashLoopSince.delete(resource);
          continue;
        }
        const previous = crashLoopSince.get(resource);
        const since = previous?.identity === diagnostic.identity ? previous.since : now;
        crashLoopSince.set(resource, { since, identity: diagnostic.identity });
        if (now - since >= CRASH_LOOP_GRACE_MS) {
          persistentCrashLoops.push({
            resource,
            message: `workload remained in CrashLoopBackOff for ${Math.round(CRASH_LOOP_GRACE_MS / 1_000)}s: ${diagnostic.message}`,
          });
        }
      }
      for (const { doc, state } of states) {
        if (state.ready) crashLoopSince.delete(docLabel(doc));
      }
      if (persistentCrashLoops.length) {
        onProgress?.({
          ready: waiting.length - pendingStates.length,
          total: waiting.length,
          pending: persistentCrashLoops,
          recovering: [...recovering.values()].map((item) => item.issue),
        });
        throw new HelmReadinessError(
          `Workload crash loop persisted: ${persistentCrashLoops.map((issue) => `${issue.resource}: ${issue.message}`).join('; ')}`,
          persistentCrashLoops,
        );
      }

      if (options.recoverMultiAttach) {
        for (const { doc, object } of pendingStates) {
          const resource = docLabel(doc);
          if (recovering.has(resource) || !isRecoverableMultiAttachDeadlock(doc, object, podDiagnostics.get(resource))) continue;
          const issue: ReadinessIssue = {
            resource,
            message: 'Kubus detected a ReadWriteOnce multi-attach deadlock and is recreating this one-replica Deployment with brief downtime',
          };
          try {
            await patchDeploymentStrategy(handle, doc, { type: 'Recreate' });
          } catch (error) {
            issue.message = `ReadWriteOnce multi-attach deadlock detected, but Kubus could not switch the Deployment to Recreate: ${
              error instanceof Error ? error.message : String(error)
            }`;
            onProgress?.({ ready: waiting.length - pendingStates.length, total: waiting.length, pending: [issue], recovering: [] });
            throw new HelmReadinessError(`${issue.resource}: ${issue.message}`, [issue]);
          }
          recovering.set(resource, { doc, originalStrategy: manifestStrategy(doc), issue });
        }
      }

      pending = pendingStates.map(({ doc, state }) => {
        const resource = docLabel(doc);
        const diagnostic = podDiagnostics.get(resource);
        const recovery = recovering.get(resource);
        const crashLoopStartedAt = crashLoopSince.get(resource)?.since;
        const crashLoopMessage =
          diagnostic?.crashLoop && crashLoopStartedAt
            ? `will stop waiting if the crash loop persists for ${Math.max(1, Math.ceil((CRASH_LOOP_GRACE_MS - (now - crashLoopStartedAt)) / 1_000))}s`
            : undefined;
        const messages = [state.message, diagnostic?.message, crashLoopMessage, recovery?.issue.message].filter(
          (message): message is string => !!message,
        );
        return { resource, message: [...new Set(messages)].join('; ') };
      });
      const recoveryIssues = [...recovering.values()].map((item) => item.issue);
      onProgress?.({ ready: waiting.length - pending.length, total: waiting.length, pending, recovering: recoveryIssues });
      if (!pending.length) return waiting.map(docLabel);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    throw new HelmReadinessError(
      `Timed out after ${timeoutSeconds}s waiting for ${pending.map((issue) => `${issue.resource} (${issue.message})`).join(', ')}`,
      pending,
    );
  } finally {
    // If another workload fails while a recovery is in flight, do not leave
    // the release with a strategy that differs from its stored manifest.
    await Promise.allSettled([...recovering.values()].map((recovery) => patchDeploymentStrategy(handle, recovery.doc, recovery.originalStrategy)));
  }
}

/** Validate rendered objects against the live API server without persisting them. */
export async function validateResources(
  handle: ClusterHandle,
  docs: KubernetesObject[],
  substituteNamespace?: { from: string; to: string },
): Promise<HelmResourceValidation[]> {
  return Promise.all(
    docs.map(async (doc) => {
      const resource = docLabel(doc);
      const candidate = structuredClone(doc);
      if (substituteNamespace && candidate.metadata?.namespace === substituteNamespace.from) {
        candidate.metadata.namespace = substituteNamespace.to;
      }
      try {
        await validateDoc(handle, candidate);
        return { resource, status: 'valid' as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A chart may install a CRD and its custom resources in the same
        // operation. Discovery cannot validate that kind until the CRD exists.
        if (message.includes('unknown kind')) {
          return { resource, status: 'warning' as const, message: `${message}; it may be supplied by this chart` };
        }
        return { resource, status: 'error' as const, message };
      }
    }),
  );
}
