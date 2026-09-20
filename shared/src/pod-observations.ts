import type { KubeObject } from './api-types.js';
import type { WatchStatusState } from './ws-protocol.js';

export interface PodTermination {
  uid: string; name: string; namespace: string; container: string;
  finishedAt: string; reason: string; exitCode: number; observedAt: string;
}
export interface PodTerminationHistory {
  items: PodTermination[];
  startedAt: string;
  state: WatchStatusState;
  interrupted: boolean;
  evicted: number;
}

/** A termination is a dated container observation, never a pod deletion time. */
export function failedPodTerminations(pod: KubeObject, observedAt: string): PodTermination[] {
  const statuses = [pod.status?.containerStatuses, pod.status?.initContainerStatuses];
  const result: PodTermination[] = [];
  for (const group of statuses) {
    if (!Array.isArray(group)) continue;
    for (const container of group) {
      for (const state of [container.state, container.lastState]) {
        const ended = state?.terminated;
        if (!ended || typeof ended.exitCode !== 'number' || ended.exitCode === 0 || !Number.isFinite(Date.parse(ended.finishedAt))) continue;
        result.push({ uid: pod.metadata.uid, name: pod.metadata.name, namespace: pod.metadata.namespace ?? '',
          container: String(container.name), finishedAt: ended.finishedAt, reason: String(ended.reason ?? 'Error'), exitCode: ended.exitCode, observedAt });
      }
    }
  }
  return result;
}
