import type { KubeObject, LogTargetKind } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { selectorMatches } from './relation-hints.js';

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }>;
}

export function selectorToString(selector: LabelSelector | undefined): string | undefined {
  if (!selector) return undefined;
  const parts = Object.entries(selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const expr of selector.matchExpressions ?? []) {
    if (expr.operator === 'In') parts.push(`${expr.key} in (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'NotIn') parts.push(`${expr.key} notin (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'Exists') parts.push(expr.key);
    else if (expr.operator === 'DoesNotExist') parts.push(`!${expr.key}`);
  }
  return parts.length ? parts.join(',') : undefined;
}

async function listPods(handle: ClusterHandle, namespace: string, selector?: string): Promise<KubeObject[]> {
  const query = new URLSearchParams();
  if (selector) query.set('labelSelector', selector);
  const list = await handle.raw.json<{ items?: KubeObject[] }>(resourcePath('', 'v1', 'pods', { namespace, query }));
  return list.items ?? [];
}

function owns(obj: KubeObject, uid: string | undefined): boolean {
  if (!uid) return false;
  return (obj.metadata.ownerReferences ?? []).some((owner) => owner.uid === uid && owner.controller);
}

/**
 * Resolve a pod/workload/service to its pods. Label selectors alone are not
 * enough for workloads — unowned pods can share the labels — so candidates
 * are filtered by controller ownership (via the owned ReplicaSets for
 * Deployments), matching what the detail views show.
 */
export async function resolveTargetPods(handle: ClusterHandle, target: KubeObject, kind: LogTargetKind, namespace: string): Promise<KubeObject[]> {
  if (kind === 'Pod') return [target];

  if (kind === 'Service') {
    const selector = (target.spec as { selector?: Record<string, string> } | undefined)?.selector;
    const labelSelector = selectorToString({ matchLabels: selector });
    return labelSelector ? listPods(handle, namespace, labelSelector) : [];
  }

  const selector = selectorToString((target.spec as { selector?: LabelSelector } | undefined)?.selector);
  if (kind === 'Job') {
    const pods = await listPods(handle, namespace, selector);
    return pods.filter((pod) => owns(pod, target.metadata.uid));
  }
  if (!selector) return [];

  if (kind === 'Deployment') {
    const query = new URLSearchParams({ labelSelector: selector });
    const [rsList, pods] = await Promise.all([
      handle.raw.json<{ items?: KubeObject[] }>(resourcePath('apps', 'v1', 'replicasets', { namespace, query })),
      listPods(handle, namespace, selector),
    ]);
    const rsUids = new Set((rsList.items ?? []).filter((rs) => owns(rs, target.metadata.uid)).map((rs) => rs.metadata.uid));
    return pods.filter((pod) => (pod.metadata.ownerReferences ?? []).some((owner) => rsUids.has(owner.uid) && owner.controller));
  }

  const pods = await listPods(handle, namespace, selector);
  return pods.filter((pod) => owns(pod, target.metadata.uid));
}

/** API coordinates of every kind a log session can target. */
export const LOG_TARGET_RESOURCES: Record<LogTargetKind, { group: string; version: string; plural: string }> = {
  Pod: { group: '', version: 'v1', plural: 'pods' },
  Deployment: { group: 'apps', version: 'v1', plural: 'deployments' },
  ReplicaSet: { group: 'apps', version: 'v1', plural: 'replicasets' },
  StatefulSet: { group: 'apps', version: 'v1', plural: 'statefulsets' },
  DaemonSet: { group: 'apps', version: 'v1', plural: 'daemonsets' },
  Service: { group: '', version: 'v1', plural: 'services' },
  Job: { group: 'batch', version: 'v1', plural: 'jobs' },
};

export type TargetPodMatcher = (pod: KubeObject) => Promise<boolean>;

/**
 * Why a target can never have pods, or undefined when pods may match it. A
 * Service without a selector (the API server's own, or one backed by
 * hand-managed EndpointSlices) selects no pods, so waiting for them is futile.
 */
export function targetWithoutPods(target: KubeObject, kind: LogTargetKind): string | undefined {
  if (kind !== 'Service') return undefined;
  const selector = (target.spec as { selector?: Record<string, string> } | undefined)?.selector;
  return selector && Object.keys(selector).length ? undefined : 'it has no pod selector';
}

/**
 * Membership test for pods that appear after a target was resolved, with the
 * same rules as resolveTargetPods. Deployments own pods through ReplicaSets
 * that a rollout creates later, so an unknown ReplicaSet owner is looked up
 * once and remembered.
 */
export function targetPodMatcher(handle: ClusterHandle, target: KubeObject, kind: LogTargetKind, namespace: string): TargetPodMatcher {
  const inNamespace = (pod: KubeObject) => (pod.metadata.namespace ?? namespace) === namespace;
  if (kind === 'Pod') {
    return async (pod) => inNamespace(pod) && pod.metadata.name === target.metadata.name;
  }
  if (kind === 'Service') {
    const selector = (target.spec as { selector?: Record<string, string> } | undefined)?.selector;
    return async (pod) => inNamespace(pod) && selectorMatches(selector ?? {}, pod.metadata.labels);
  }
  const selector = (target.spec as { selector?: LabelSelector } | undefined)?.selector;
  const labelsMatch = (pod: KubeObject) => !selector || selectorMatches(selector, pod.metadata.labels);
  if (kind === 'Job') {
    return async (pod) => inNamespace(pod) && owns(pod, target.metadata.uid) && labelsMatch(pod);
  }
  if (!selector) return async () => false;
  if (kind !== 'Deployment') {
    return async (pod) => inNamespace(pod) && labelsMatch(pod) && owns(pod, target.metadata.uid);
  }

  const replicaSetOwned = new Map<string, Promise<boolean>>();
  return async (pod) => {
    if (!inNamespace(pod) || !labelsMatch(pod)) return false;
    const owner = (pod.metadata.ownerReferences ?? []).find((ref) => ref.controller && ref.kind === 'ReplicaSet');
    if (!owner) return false;
    let owned = replicaSetOwned.get(owner.uid);
    if (!owned) {
      owned = handle.raw
        .json<KubeObject>(resourcePath('apps', 'v1', 'replicasets', { namespace, name: owner.name }))
        .then((rs) => rs.metadata.uid === owner.uid && owns(rs, target.metadata.uid))
        .catch(() => {
          // Ask again on the pod's next update rather than excluding it for good.
          replicaSetOwned.delete(owner.uid);
          return false;
        });
      replicaSetOwned.set(owner.uid, owned);
    }
    return owned;
  };
}
