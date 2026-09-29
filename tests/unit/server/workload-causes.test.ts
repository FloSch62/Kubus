import { describe, expect, it } from 'vitest';
import type { KubeObject, OverviewWorkloadIssue } from '@kubus/shared';
import { attachWorkloadCauses, podCause, podWorkload } from '../../../server/src/kube/workload-causes.js';

const now = Date.parse('2026-09-29T12:00:00Z');

function pod(name: string, body: { owner?: { kind: string; name: string }; hash?: string; status?: Record<string, unknown>; namespace?: string } = {}): KubeObject {
  return {
    metadata: {
      name,
      namespace: body.namespace ?? 'ns',
      uid: `uid-${name}`,
      labels: body.hash ? { 'pod-template-hash': body.hash } : undefined,
      ownerReferences: body.owner ? [{ apiVersion: 'v1', kind: body.owner.kind, name: body.owner.name, uid: 'o', controller: true }] : undefined,
    },
    status: body.status,
  } as KubeObject;
}

function warning(kind: string, name: string, reason: string, message: string, at = '2026-09-29T11:59:00Z', namespace = 'ns'): KubeObject {
  return {
    metadata: { name: `${name}.${reason}`, namespace, uid: `ev-${name}-${reason}` },
    type: 'Warning',
    reason,
    message,
    lastTimestamp: at,
    involvedObject: { kind, name, namespace },
  } as unknown as KubeObject;
}

const issue = (kind: string, name: string): OverviewWorkloadIssue => ({ kind, namespace: 'ns', name, reason: 'Unavailable' });

describe('podWorkload', () => {
  it('resolves ReplicaSet owners to their Deployment through the template hash', () => {
    expect(podWorkload(pod('web-7d9f-abcde', { owner: { kind: 'ReplicaSet', name: 'web-7d9f' }, hash: '7d9f' }))).toBe('Deployment/web');
    expect(podWorkload(pod('orphan-x', { owner: { kind: 'ReplicaSet', name: 'orphan' } }))).toBe('ReplicaSet/orphan');
    expect(podWorkload(pod('db-0', { owner: { kind: 'StatefulSet', name: 'db' } }))).toBe('StatefulSet/db');
    expect(podWorkload(pod('bare'))).toBeUndefined();
  });
});

describe('podCause', () => {
  it('reads a pull failure with its image', () => {
    const cause = podCause(
      pod('a', {
        status: {
          phase: 'Pending',
          containerStatuses: [{ name: 'app', image: 'registry.invalid/broken:latest', state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image' } } }],
        },
      }),
    );
    expect(cause).toMatchObject({ reason: 'ImagePullBackOff', image: 'registry.invalid/broken:latest', source: { kind: 'Pod', name: 'a' } });
  });

  it('reads a crash loop with restarts and the last exit code', () => {
    const cause = podCause(
      pod('b', {
        status: {
          phase: 'Running',
          containerStatuses: [
            { name: 'app', restartCount: 56, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error', exitCode: 1 } } },
          ],
        },
      }),
    );
    expect(cause).toMatchObject({ reason: 'CrashLoopBackOff', restarts: 56, exitCode: 1 });
  });

  it('reads the scheduler condition, falling back to the FailedScheduling event', () => {
    const pending = (message?: string) =>
      pod('c', { status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', ...(message ? { message } : {}) }] } });
    expect(podCause(pending('0/1 nodes are available: 1 Insufficient cpu.'))?.message).toBe('0/1 nodes are available: 1 Insufficient cpu.');
    expect(podCause(pending(), [{ reason: 'FailedScheduling', message: 'from event' }])).toMatchObject({ reason: 'Unschedulable', message: 'from event' });
  });

  it('keeps naming a restarting container that just failed a crash loop', () => {
    const cause = podCause(
      pod('flaky-1', {
        status: {
          phase: 'Running',
          containerStatuses: [{ name: 'app', ready: false, restartCount: 56, state: { terminated: { reason: 'Error', exitCode: 1 } } }],
        },
      }),
    );
    expect(cause).toMatchObject({ reason: 'CrashLoopBackOff', exitCode: 1, restarts: 56 });
  });

  it('ignores normal start-up states', () => {
    expect(podCause(pod('d', { status: { phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] } }))).toBeUndefined();
    expect(podCause(pod('e', { status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] } }))).toBeUndefined();
  });
});

describe('attachWorkloadCauses', () => {
  it('explains a Deployment from its pods and counts the pods sharing the reason', () => {
    const pods = ['x1', 'x2'].map((suffix) =>
      pod(`web-abc-${suffix}`, {
        owner: { kind: 'ReplicaSet', name: 'web-abc' },
        hash: 'abc',
        status: { phase: 'Pending', containerStatuses: [{ name: 'app', image: 'nope:1', state: { waiting: { reason: 'ErrImagePull' } } }] },
      }),
    );
    const [out] = attachWorkloadCauses([issue('Deployment', 'web')], pods, [], now);
    expect(out?.cause).toMatchObject({ reason: 'ErrImagePull', pods: 2, image: 'nope:1', source: { name: 'web-abc-x1' } });
  });

  it('prefers a crash over a pod that is only not ready', () => {
    const pods = [
      pod('db-0', { owner: { kind: 'StatefulSet', name: 'db' }, status: { phase: 'Running', containerStatuses: [{ name: 'a', ready: false, state: { running: {} } }] } }),
      pod('db-1', { owner: { kind: 'StatefulSet', name: 'db' }, status: { phase: 'Running', containerStatuses: [{ name: 'a', restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }),
    ];
    const [out] = attachWorkloadCauses([issue('StatefulSet', 'db')], pods, [], now);
    expect(out?.cause).toMatchObject({ reason: 'CrashLoopBackOff', source: { name: 'db-1' }, pods: 1 });
  });

  it('falls back to controller events when no pod exists', () => {
    const quota = 'Create Pod gpu-0 in StatefulSet gpu failed error: pods "gpu-0" is forbidden: exceeded quota: gpu-quota';
    const rsEvent = warning('ReplicaSet', 'api-5f6', 'FailedCreate', 'exceeded quota: team', '2026-09-29T11:58:00Z');
    const [sts, deploy] = attachWorkloadCauses(
      [issue('StatefulSet', 'gpu'), issue('Deployment', 'api')],
      [],
      [warning('StatefulSet', 'gpu', 'FailedCreate', quota), rsEvent],
      now,
    );
    expect(sts?.cause).toEqual({ reason: 'FailedCreate', message: quota, source: { kind: 'StatefulSet', name: 'gpu' } });
    expect(deploy?.cause).toMatchObject({ reason: 'FailedCreate', source: { kind: 'ReplicaSet', name: 'api-5f6' } });
  });

  it('reads PVC provisioning failures and skips stale or foreign events', () => {
    const [pvc, stale] = attachWorkloadCauses(
      [
        { kind: 'PersistentVolumeClaim', namespace: 'ns', name: 'data', reason: 'Pending' },
        { kind: 'PersistentVolumeClaim', namespace: 'ns', name: 'old', reason: 'Pending' },
      ],
      [],
      [
        warning('PersistentVolumeClaim', 'data', 'ProvisioningFailed', 'storageclass.storage.k8s.io "fast" not found'),
        warning('PersistentVolumeClaim', 'data', 'ProvisioningFailed', 'elsewhere', '2026-09-29T11:59:30Z', 'other-ns'),
        warning('PersistentVolumeClaim', 'old', 'ProvisioningFailed', 'yesterday', '2026-09-27T10:00:00Z'),
      ],
      now,
    );
    expect(pvc?.cause?.message).toBe('storageclass.storage.k8s.io "fast" not found');
    expect(stale?.cause).toBeUndefined();
  });

  it('leaves kinds without pods or events untouched', () => {
    const quota: OverviewWorkloadIssue = { kind: 'ResourceQuota', namespace: 'ns', name: 'q', reason: 'AtQuota', message: 'pods 3/3' };
    expect(attachWorkloadCauses([quota], [], [], now)).toEqual([quota]);
  });
});
