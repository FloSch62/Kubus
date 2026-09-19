import { describe, expect, it } from 'vitest';
import { nodePods, nodeTargets, nodeStages, nodeIssue, mountedClaims } from '../../../plugins/clabernetes/src/runtime.js';
import type { Located } from '../../../plugins/clabernetes/src/model.js';
const node: Located = {
  ctx: 'cluster-a',
  group: 'c9s.run',
  plural: 'nodes',
  metadata: { name: 'child', namespace: 'lab', generation: 2 },
  status: { directContainers: [{ name: 'child-device', componentID: 'primary' }] },
};
const pod: Located = {
  ctx: 'cluster-a',
  group: '',
  plural: 'pods',
  metadata: {
    name: 'shared-pod',
    namespace: 'lab',
    labels: { 'c9s.run/direct-workload': 'parent' },
    annotations: { 'kubectl.kubernetes.io/default-container': 'parent-device' },
  },
  spec: {
    containers: [{ name: 'parent-device' }, { name: 'child-device' }],
    initContainers: [{ name: 'planner' }, { name: 'clabwire', restartPolicy: 'Always' }],
    volumes: [
      { name: 'artifacts', persistentVolumeClaim: { claimName: 'child' } },
      { name: 'plan', configMap: { name: 'plan' } },
    ],
  },
  status: {
    containerStatuses: [{ name: 'child-device', state: { running: {} }, ready: false, restartCount: 3 }],
    initContainerStatuses: [
      { name: 'planner', state: { terminated: { reason: 'Completed' } } },
      { name: 'clabwire', state: { running: {} }, ready: true },
    ],
  },
};
describe('c9s direct runtime access', () => {
  it('targets the logical child in a shared Pod without using the parent default container', () => {
    expect(nodePods(node, [pod])).toEqual([pod]);
    const targets = nodeTargets(node, [pod]);
    expect(targets.map((t) => t.name)).toEqual(['child-device', 'planner', 'clabwire']);
    expect(targets[0]).toMatchObject({ running: true, ready: false, restarts: 3 });
    expect(targets[1]).toMatchObject({ role: 'Preparation', state: 'Completed', helper: true, running: false });
    expect(targets[2]).toMatchObject({ role: 'Connectivity', running: true, helper: true });
  });
  it('never mixes identically named containers across clusters or namespaces', () => {
    expect(
      nodeTargets(node, [
        { ...pod, ctx: 'cluster-b' },
        { ...pod, metadata: { ...pod.metadata, namespace: 'elsewhere' } },
      ]),
    ).toEqual([]);
  });
  it('selects the replacement Pod, disables shell while it waits, and avoids terminating Pods', () => {
    const old = { ...pod, metadata: { ...pod.metadata, deletionTimestamp: '2026-09-19T12:00:00Z' } };
    const replacement = {
      ...pod,
      metadata: { ...pod.metadata, name: 'new' },
      status: { containerStatuses: [{ name: 'child-device', state: { waiting: { reason: 'ImagePullBackOff' } } }] },
    };
    expect(nodeTargets(node, [old, replacement])[0]).toMatchObject({
      pod: { metadata: { name: 'new' } },
      running: false,
      state: 'ImagePullBackOff',
    });
    expect(nodeTargets(node, [old])[0]?.running).toBe(false);
  });
  it('reads current conditions without treating stale success as ready', () => {
    const n = {
      ...node,
      status: {
        conditions: [
          { type: 'PlanApplied', status: 'True', observedGeneration: 1 },
          { type: 'ConnectivityReady', status: 'False', observedGeneration: 2, reason: 'PeerUnavailable' },
        ],
      },
    };
    expect(nodeStages(n).find((s) => s.type === 'PlanApplied')?.state).toBe('Stale');
    expect(nodeStages(n).find((s) => s.type === 'Prepared')?.state).toBe('Unknown');
    expect(nodeStages(n).find((s) => s.type === 'ConnectivityReady')?.action).toBe('clabwire');
    expect(nodeIssue(n)).toBe('Plan: awaiting current generation');
  });
  it('reports actually mounted storage rather than assuming the Topology policy is effective', () => {
    expect(mountedClaims(pod)).toEqual(['child']);
    expect(mountedClaims({ ...pod, spec: { volumes: [{ emptyDir: {} }] } })).toEqual([]);
  });
});
