import type { LogTargetKind } from '@kubus/shared';
import { resolveLogTargetPods } from '../api/queries.js';
import { dockTabId, type DockTab } from '../state/dock.js';

export interface LogTargetRef {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: LogTargetKind;
  namespace: string;
  name: string;
}

/**
 * Resolve a pod, workload or Service to its pods and open one logs dock tab
 * per namespace. A workload with no pods yet (scaled to zero, first rollout
 * still scheduling) still gets a tab: it follows the workload, so the pods
 * join as they start. Only a Pod that cannot be found is an error.
 */
export async function openLogsForTarget(ref: LogTargetRef, addTab: (tab: DockTab) => void): Promise<void> {
  const { pods } = await resolveLogTargetPods(ref);
  if (!pods.length) {
    if (ref.kind === 'Pod') throw new Error(`No pods found for ${ref.kind} ${ref.namespace}/${ref.name}`);
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: `logs: ${ref.kind}/${ref.name}`,
      ctx: ref.ctx,
      namespace: ref.namespace,
      pods: [],
      sources: [],
      target: { kind: ref.kind, name: ref.name },
      follow: true,
    });
    return;
  }
  const byNamespace = new Map<string, typeof pods>();
  for (const pod of pods) {
    const namespacePods = byNamespace.get(pod.namespace);
    if (namespacePods) namespacePods.push(pod);
    else byNamespace.set(pod.namespace, [pod]);
  }
  for (const [ns, namespacePods] of byNamespace) {
    const podNames = namespacePods.map((pod) => pod.name);
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: pods.length === 1 ? `logs: ${podNames[0] ?? ref.name}` : `logs: ${ref.kind}/${ref.name}`,
      ctx: ref.ctx,
      namespace: ns,
      pods: podNames,
      sources: namespacePods.map((pod) => ({ pod: pod.name, containers: pod.containers })),
      target: { kind: ref.kind, name: ref.name },
      follow: true,
    });
  }
}
