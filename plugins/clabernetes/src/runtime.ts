import { belongsToNode, object, string, type Located } from './model.js';

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export interface ContainerTarget {
  pod: Located;
  name: string;
  role: string;
  state: string;
  ready: boolean;
  running: boolean;
  restarts: number;
  helper: boolean;
  image: string;
}

/** Match plan-addressed containers as well as labels: several logical Nodes can share a Pod. */
export function nodePods(node: Located, pods: Located[]): Located[] {
  const names = new Set(records(node.status?.directContainers).map((c) => c.name));
  return pods
    .filter(
      (p) =>
        p.ctx === node.ctx &&
        p.metadata.namespace === node.metadata.namespace &&
        (belongsToNode(p, node) || records(p.spec?.containers).some((c) => names.has(c.name))),
    )
    .sort(
      (a, b) =>
        Number(!!a.metadata.deletionTimestamp) - Number(!!b.metadata.deletionTimestamp) ||
        string(b.metadata.creationTimestamp, '').localeCompare(string(a.metadata.creationTimestamp, '')),
    );
}
export function podTargets(pod: Located): ContainerTarget[] {
  const statuses = [...records(pod.status?.containerStatuses), ...records(pod.status?.initContainerStatuses)];
  return [...records(pod.spec?.containers), ...records(pod.spec?.initContainers)].map((c) => {
    const s = statuses.find((v) => v.name === c.name);
    const state = object(s?.state);
    const helper = records(pod.spec?.initContainers).some((i) => i.name === c.name);
    return {
      pod,
      name: string(c.name),
      helper,
      role: c.name === 'planner' ? 'Preparation' : c.name === 'clabwire' ? 'Connectivity' : helper ? 'Init' : 'Device',
      state: string(object(state.waiting).reason, string(object(state.terminated).reason, state.running ? 'Running' : 'Waiting')),
      ready: s?.ready === true,
      running: !!state.running && !pod.metadata.deletionTimestamp,
      restarts: typeof s?.restartCount === 'number' ? s.restartCount : 0,
      image: string(c.image),
    };
  });
}
export function nodeTargets(node: Located, pods: Located[]): ContainerTarget[] {
  const observations = records(node.status?.directContainers);
  const pod = nodePods(node, pods)[0];
  if (!pod) return [];
  const defaultName = pod.metadata.annotations?.['kubectl.kubernetes.io/default-container'];
  return podTargets(pod)
    .filter((c) => c.helper || (observations.length ? observations.some((o) => o.name === c.name) : belongsToNode(pod, node)))
    .map((c) => {
      const observed = observations.find((o) => o.name === c.name);
      return { ...c, role: c.helper ? c.role : string(observed?.componentID, 'Device') };
    })
    .sort((a, b) => Number(a.helper) - Number(b.helper) || Number(b.name === defaultName) - Number(a.name === defaultName));
}

export const stages = [
  { type: 'NodeProfileResolved', label: 'Profile', hint: 'Resolve the same-namespace NodeProfile.', action: 'profile' },
  {
    type: 'PlanApplied',
    label: 'Plan',
    hint: 'Check Node events and the manager / shared planner pool. No Pod is created until planning succeeds.',
    action: 'controller',
  },
  {
    type: 'Prepared',
    label: 'Files',
    hint: 'Read preparation logs for artifact verification, startup configuration and preserved files.',
    action: 'planner',
  },
  {
    type: 'ConnectivityReady',
    label: 'Wiring',
    hint: 'Read clabwire logs for the failed invariant. Check Link acceptance; fabric uses UDP 14790, management uses UDP 14789.',
    action: 'clabwire',
  },
  {
    type: 'ContainersReady',
    label: 'Device',
    hint: 'Read device logs and startup probes. A running process can still be waiting for NOS readiness.',
    action: 'device',
  },
] as const;
export function nodeStages(node: Located) {
  return stages.map((stage) => {
    const condition = node.status?.conditions?.find((c) => c.type === stage.type);
    const stale = condition?.observedGeneration !== undefined && condition.observedGeneration < (node.metadata.generation ?? 0);
    return {
      ...stage,
      condition,
      state: stale ? 'Stale' : condition?.status === 'True' ? 'Ready' : condition?.status === 'False' ? 'Blocked' : 'Unknown',
    };
  });
}
export function nodeIssue(node: Located): string {
  const blocked = nodeStages(node).find((s) => s.state === 'Blocked' || s.state === 'Stale');
  return blocked
    ? `${blocked.label}: ${blocked.state === 'Stale' ? 'awaiting current generation' : (blocked.condition?.reason ?? 'waiting')}`
    : '';
}
export function mountedClaims(pod: Located): string[] {
  return records(pod.spec?.volumes).flatMap((v) => {
    const name = object(v.persistentVolumeClaim).claimName;
    return typeof name === 'string' ? [name] : [];
  });
}
export function profileFor(node: Located, profiles: Located[]): Located | undefined {
  const name = object(node.spec?.profileRef).name;
  return profiles.find((p) => p.ctx === node.ctx && p.metadata.namespace === node.metadata.namespace && p.metadata.name === name);
}
