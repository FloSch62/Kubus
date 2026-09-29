import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { describeSchedulerMessage, nodeNamesIn, parseSchedulerMessage, pinnedNode, podSchedulingIssue } from '../../../client/src/components/detail/scheduling';
import { controllerEventProblems, podProblems } from '../../../client/src/components/detail/workload-problems';

const CPU = '0/1 nodes are available: 1 Insufficient cpu. no new claims to deallocate, preemption: 0/1 nodes are available: 1 Preemption is not helpful for scheduling.';

function pendingPod(name: string, extra: { conditions?: unknown[]; spec?: Record<string, unknown>; phase?: string; nodeName?: string } = {}): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'apps', uid: `uid-${name}` },
    spec: { containers: [{ name: 'app' }], ...(extra.nodeName && { nodeName: extra.nodeName }), ...extra.spec },
    status: { phase: extra.phase ?? 'Pending', conditions: extra.conditions ?? [] },
  } as unknown as KubeObject;
}

const unschedulable = (message: string) => [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message, lastTransitionTime: '2026-09-29T09:00:00Z' }];

describe('scheduler messages', () => {
  it('splits the per-reason node counts and drops the preemption tail', () => {
    expect(parseSchedulerMessage(CPU)).toEqual({ available: '0/1', reasons: [{ count: 1, text: 'Insufficient cpu' }] });
    expect(
      parseSchedulerMessage('0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient memory. preemption: …'),
    ).toEqual({
      available: '0/3',
      reasons: [
        { count: 1, text: 'node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }' },
        { count: 2, text: 'Insufficient memory' },
      ],
    });
  });

  it('summarizes for the banner and shortens for the pod row', () => {
    expect(describeSchedulerMessage(CPU)).toEqual({ summary: '0/1 nodes available, Insufficient cpu', short: 'Insufficient cpu' });
    expect(describeSchedulerMessage('0/3 nodes are available: 1 node(s) had untolerated taint {dedicated: gpu}, 2 node(s) didn\'t match Pod\'s node affinity/selector.')).toEqual({
      summary: '0/3 nodes available, untolerated taint dedicated (1), node affinity/selector mismatch (2)',
      short: 'untolerated taint dedicated, node affinity/selector mismatch',
    });
    expect(describeSchedulerMessage('0/2 nodes are available: pod has unbound immediate PersistentVolumeClaims.').short).toBe('unbound PersistentVolumeClaim');
    // Anything else keeps its first sentence.
    expect(describeSchedulerMessage('running PreBind plugin "VolumeBinding": binding volumes: timed out. Retrying.')).toEqual({
      summary: 'running PreBind plugin "VolumeBinding": binding volumes: timed out',
      short: 'running PreBind plugin "VolumeBinding": binding volumes: timed out',
    });
  });

  it('finds quoted node names in a message', () => {
    expect(nodeNamesIn('pod assigned to node "worker-2" but node "worker-2" is gone')).toEqual(['worker-2']);
    expect(nodeNamesIn(CPU)).toEqual([]);
    expect(nodeNamesIn(undefined)).toEqual([]);
  });
});

describe('podSchedulingIssue', () => {
  it('reads PodScheduled=False and dates it by the latest FailedScheduling event', () => {
    const pod = pendingPod('web-1', { conditions: unschedulable(CPU) });
    expect(podSchedulingIssue(pod)).toEqual({
      summary: '0/1 nodes available, Insufficient cpu',
      short: 'Insufficient cpu',
      message: CPU,
      at: '2026-09-29T09:00:00Z',
      node: undefined,
    });
    const warnings = [{ reason: 'FailedScheduling', message: CPU, count: 3, lastTimestamp: '2026-09-29T10:00:00Z', uid: 'uid-web-1' }];
    expect(podSchedulingIssue(pod, warnings)?.at).toBe('2026-09-29T10:00:00Z');
  });

  it('falls back to the event when the pod carries no condition, ignoring a predecessor’s events', () => {
    const pod = pendingPod('web-2');
    expect(podSchedulingIssue(pod)).toBeUndefined();
    expect(podSchedulingIssue(pod, [{ reason: 'FailedScheduling', message: CPU, count: 1, uid: 'someone-else' }])).toBeUndefined();
    expect(podSchedulingIssue(pod, [{ reason: 'FailedScheduling', message: CPU, count: 1, uid: 'uid-web-2' }])?.short).toBe('Insufficient cpu');
  });

  it('has nothing to say about scheduled, running or deleted pods', () => {
    expect(podSchedulingIssue(pendingPod('a', { nodeName: 'node-a', conditions: unschedulable(CPU) }))).toBeUndefined();
    expect(podSchedulingIssue(pendingPod('b', { phase: 'Running', conditions: unschedulable(CPU) }))).toBeUndefined();
    expect(podSchedulingIssue(pendingPod('c', { conditions: [{ type: 'PodScheduled', status: 'True' }] }))).toBeUndefined();
  });

  it('names the node a DaemonSet pod is pinned to, and scheduling gates', () => {
    const daemon = pendingPod('agent-x', {
      conditions: unschedulable(CPU),
      spec: { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-7'] }] }] } } } },
    });
    expect(pinnedNode(daemon)).toBe('node-7');
    expect(podSchedulingIssue(daemon)?.node).toBe('node-7');

    const gated = pendingPod('gated', {
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'SchedulingGated', message: 'Scheduling is blocked due to non-empty scheduling gates' }],
      spec: { schedulingGates: [{ name: 'example.com/quota' }] },
    });
    expect(podSchedulingIssue(gated)).toMatchObject({ short: 'scheduling gate example.com/quota', summary: 'held by scheduling gate example.com/quota' });
  });
});

describe('podProblems', () => {
  it('groups unschedulable pods by the scheduler’s answer and collects their nodes', () => {
    const pinned = (name: string, node: string) =>
      pendingPod(name, {
        conditions: unschedulable(CPU),
        spec: { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [node] }] }] } } } },
      });
    const items = podProblems([pinned('a', 'node-1'), pinned('b', 'node-2')]);
    expect(items).toEqual([{ title: '2 pods Pending: 0/1 nodes available, Insufficient cpu', message: CPU, at: '2026-09-29T09:00:00Z', nodes: ['node-1', 'node-2'] }]);
  });

  it('uses a scheduled pod’s latest warning when its state carries no message', () => {
    const creating = {
      ...pendingPod('db-0', { nodeName: 'node-a' }),
      status: { phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] },
    } as unknown as KubeObject;
    const warnings = [
      { reason: 'FailedMount', message: 'MountVolume.SetUp failed for volume "data"', count: 2, lastTimestamp: '2026-09-29T10:00:00Z' },
      { reason: 'FailedScheduling', message: CPU, count: 1, lastTimestamp: '2026-09-29T09:00:00Z' },
    ];
    expect(podProblems([creating], () => warnings)).toEqual([
      { title: '1 pod ContainerCreating', message: 'FailedMount: MountVolume.SetUp failed for volume "data"', at: '2026-09-29T10:00:00Z' },
    ]);
  });

  it('reports a controller’s create failures with their lifetime count', () => {
    const quota = 'create Pod db-0 in StatefulSet db failed error: pods "db-0" is forbidden: exceeded quota: gpu-quota';
    expect(
      controllerEventProblems([
        { reason: 'FailedCreate', message: quota, count: 1, total: 14, lastTimestamp: '2026-09-29T10:00:00Z' },
        { reason: 'FailedUpdate', message: 'conflict', count: 1 },
      ]),
    ).toEqual([{ title: 'FailedCreate', message: quota, count: 14, at: '2026-09-29T10:00:00Z' }]);
  });
});
