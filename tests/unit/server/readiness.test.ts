import type { KubernetesObject } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { rolloutSafetyWarnings, workloadState } from '../../../server/src/helm/readiness.js';

describe('workloadState', () => {
  it('requires a Deployment generation and every rollout counter to converge', () => {
    const ready = workloadState('Deployment', {
      metadata: { generation: 4 },
      spec: { replicas: 2 },
      status: {
        observedGeneration: 4,
        updatedReplicas: 2,
        availableReplicas: 2,
        readyReplicas: 2,
        replicas: 2,
      },
    });
    expect(ready).toEqual({ ready: true, message: '2/2 available, 2/2 updated, 2/2 total' });

    expect(
      workloadState('Deployment', {
        metadata: { generation: 4 },
        spec: { replicas: 2 },
        status: {
          observedGeneration: 3,
          updatedReplicas: 2,
          availableReplicas: 2,
          readyReplicas: 2,
          replicas: 2,
        },
      }).ready,
    ).toBe(false);

    // An old available pod plus two desired pods is still mid-rollout.
    expect(
      workloadState('Deployment', {
        metadata: { generation: 4 },
        spec: { replicas: 2 },
        status: {
          observedGeneration: 4,
          updatedReplicas: 2,
          availableReplicas: 2,
          readyReplicas: 2,
          replicas: 3,
        },
      }).ready,
    ).toBe(false);
  });

  it('fails a Deployment on ProgressDeadlineExceeded', () => {
    expect(
      workloadState('Deployment', {
        status: {
          conditions: [
            {
              type: 'Progressing',
              status: 'False',
              reason: 'ProgressDeadlineExceeded',
              message: 'rollout made no progress',
            },
          ],
        },
      }),
    ).toEqual({ ready: false, failed: true, message: 'rollout made no progress' });
  });

  it('handles StatefulSet partitions and OnDelete strategies', () => {
    const partitioned = workloadState('StatefulSet', {
      metadata: { generation: 2 },
      spec: { replicas: 5, updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 3 } } },
      status: { observedGeneration: 2, readyReplicas: 5, updatedReplicas: 2 },
    });
    expect(partitioned.ready).toBe(true);

    const onDelete = workloadState('StatefulSet', {
      metadata: { generation: 2 },
      spec: { replicas: 2, updateStrategy: { type: 'OnDelete' } },
      status: { observedGeneration: 2, readyReplicas: 2, updatedReplicas: 0 },
    });
    expect(onDelete.ready).toBe(true);
  });

  it('waits for every desired DaemonSet pod and the observed generation', () => {
    const object = {
      metadata: { generation: 7 },
      status: {
        observedGeneration: 7,
        desiredNumberScheduled: 3,
        updatedNumberScheduled: 3,
        numberReady: 3,
      },
    };
    expect(workloadState('DaemonSet', object)).toEqual({ ready: true, message: '3/3 pods ready' });
    expect(workloadState('DaemonSet', { ...object, status: { ...object.status, numberReady: 2 } }).ready).toBe(false);
    expect(workloadState('DaemonSet', { ...object, status: { ...object.status, observedGeneration: 6 } }).ready).toBe(false);
  });

  it('distinguishes failed, complete, and pending Jobs', () => {
    expect(
      workloadState('Job', {
        status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] },
      }),
    ).toEqual({ ready: false, failed: true, message: 'BackoffLimitExceeded' });
    expect(workloadState('Job', { status: { conditions: [{ type: 'Complete', status: 'True' }] } }).ready).toBe(true);
    expect(workloadState('Job', {}).message).toBe('job has not completed');
  });

  it('surfaces Pod runtime and scheduling failures', () => {
    const failed = workloadState('Pod', {
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'worker',
            restartCount: 2,
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'backing off' } },
          },
        ],
      },
    });
    expect(failed.failed).toBe(true);
    expect(failed.message).toContain('worker is CrashLoopBackOff after 2 restarts: backing off');

    const unschedulable = workloadState('Pod', {
      status: {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'no nodes fit' }],
      },
    });
    expect(unschedulable).toEqual({ ready: false, message: 'pod phase is Pending; no nodes fit' });
  });

  it('recognizes successful and ready Pods', () => {
    expect(workloadState('Pod', { status: { phase: 'Succeeded' } })).toEqual({ ready: true, message: 'pod completed' });
    expect(
      workloadState('Pod', {
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      }).ready,
    ).toBe(true);
  });

  it('waits for bound PVCs and treats non-waited kinds as ready', () => {
    expect(workloadState('PersistentVolumeClaim', { status: { phase: 'Pending' } })).toEqual({
      ready: false,
      message: 'PVC phase is Pending',
    });
    expect(workloadState('PersistentVolumeClaim', { status: { phase: 'Bound' } }).ready).toBe(true);
    expect(workloadState('Service', {})).toEqual({ ready: true, message: 'ready' });
  });
});

function deployment(overrides: Record<string, unknown> = {}): KubernetesObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'app' },
    spec: {
      replicas: 1,
      strategy: { type: 'RollingUpdate' },
      template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'data' } }] } },
      ...overrides,
    },
  } as KubernetesObject;
}

function claim(accessModes: string[] = ['ReadWriteOnce'], namespace = 'app'): KubernetesObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'data', namespace },
    spec: { accessModes },
  } as KubernetesObject;
}

describe('rolloutSafetyWarnings', () => {
  it('warns for a one-replica rolling Deployment mounting an RWO claim', () => {
    expect(rolloutSafetyWarnings([deployment(), claim()])).toEqual([
      'Deployment/app/web mounts ReadWriteOnce PVC data with a one-replica rolling strategy. If Kubernetes reports a multi-attach deadlock, Kubus will recreate this workload with brief downtime.',
    ]);
  });

  it('also treats ReadWriteOncePod as an exclusive claim mode', () => {
    expect(rolloutSafetyWarnings([deployment(), claim(['ReadWriteOncePod'])])).toHaveLength(1);
  });

  it.each([
    ['multiple replicas', { replicas: 2 }, claim()],
    ['Recreate strategy', { strategy: { type: 'Recreate' } }, claim()],
    ['an absolute maxUnavailable', { strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } } }, claim()],
    ['a percentage maxUnavailable', { strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: '100%' } } }, claim()],
    ['a non-exclusive claim', {}, claim(['ReadWriteMany'])],
    ['a claim in another namespace', {}, claim(['ReadWriteOnce'], 'other')],
  ])('does not warn for %s', (_label, spec, pvc) => {
    expect(rolloutSafetyWarnings([deployment(spec), pvc])).toEqual([]);
  });

  it('reports every risky claim mounted by the Deployment', () => {
    const app = deployment({
      template: {
        spec: {
          volumes: [
            { persistentVolumeClaim: { claimName: 'data' } },
            { persistentVolumeClaim: { claimName: 'cache' } },
          ],
        },
      },
    });
    const cache = { ...claim(), metadata: { name: 'cache', namespace: 'app' } };

    expect(rolloutSafetyWarnings([app, claim(), cache])[0]).toContain('ReadWriteOnce PVC data, ReadWriteOnce PVC cache');
  });
});
