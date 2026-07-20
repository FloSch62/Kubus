import type { KubeObject, LogTargetKind } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';

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
