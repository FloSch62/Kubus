import type { KubeObject } from '@kubus/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  hpaProblems,
  ingressHosts,
  jobPhase,
  jobStatus,
  nodeConditions,
  nodeRoles,
  nodeStatus,
  nodeTaints,
  normalizeForDiff,
  podRequestTotals,
  podSummary,
  servicePorts,
  statusLikeName,
  workloadReady,
} from '../../../client/src/kube-display';

let uidSeq = 0;

function kobj(parts: Partial<KubeObject> = {}, meta: Partial<KubeObject['metadata']> = {}): KubeObject {
  return {
    ...parts,
    metadata: { name: 'obj', uid: `uid-${++uidSeq}`, ...meta },
  };
}

describe('podSummary', () => {
  it('counts ready containers, restarts and reports the node', () => {
    const pod = kobj({
      spec: { nodeName: 'w1', containers: [{ name: 'a' }, { name: 'b' }] },
      status: {
        phase: 'Running',
        containerStatuses: [
          { name: 'a', ready: true, restartCount: 1, state: { running: {} } },
          { name: 'b', ready: false, restartCount: 4, state: { running: {} } },
        ],
      },
    });
    expect(podSummary(pod)).toEqual({ ready: '1/2', status: 'Running', restarts: 5, node: 'w1' });
  });

  it('prefers the status reason over the phase', () => {
    const pod = kobj({ status: { phase: 'Failed', reason: 'Evicted' } });
    expect(podSummary(pod).status).toBe('Evicted');
  });

  it('shows Terminating for deleted pods regardless of container state', () => {
    const pod = kobj(
      {
        status: {
          phase: 'Running',
          containerStatuses: [{ name: 'a', state: { waiting: { reason: 'CrashLoopBackOff' } } }],
        },
      },
      { deletionTimestamp: '2026-07-22T10:00:00Z' },
    );
    expect(podSummary(pod).status).toBe('Terminating');
  });

  it('surfaces waiting reasons', () => {
    const pod = kobj({
      status: {
        phase: 'Pending',
        containerStatuses: [{ name: 'a', state: { waiting: { reason: 'ImagePullBackOff' } } }],
      },
    });
    expect(podSummary(pod).status).toBe('ImagePullBackOff');
  });

  it('ignores the PodInitializing waiting reason', () => {
    const pod = kobj({
      status: {
        phase: 'Pending',
        containerStatuses: [{ name: 'a', state: { waiting: { reason: 'PodInitializing' } } }],
      },
    });
    expect(podSummary(pod).status).toBe('Pending');
  });

  it('surfaces terminated reasons only over a Running phase', () => {
    const running = kobj({
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'a', state: { terminated: { reason: 'OOMKilled' } } }],
      },
    });
    expect(podSummary(running).status).toBe('OOMKilled');
    const pending = kobj({
      status: {
        phase: 'Pending',
        containerStatuses: [{ name: 'a', state: { terminated: { reason: 'OOMKilled' } } }],
      },
    });
    expect(podSummary(pending).status).toBe('Pending');
  });

  it('does not surface the Completed terminated reason', () => {
    const pod = kobj({
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'a', state: { terminated: { reason: 'Completed' } } }],
      },
    });
    expect(podSummary(pod).status).toBe('Running');
  });

  it('checks init container statuses first', () => {
    const pod = kobj({
      status: {
        phase: 'Pending',
        initContainerStatuses: [{ name: 'init', state: { waiting: { reason: 'ErrImagePull' } } }],
        containerStatuses: [{ name: 'a', state: { waiting: { reason: 'PodInitializing' } } }],
      },
    });
    expect(podSummary(pod).status).toBe('ErrImagePull');
  });

  it('falls back to status counts when the spec is missing', () => {
    const pod = kobj({
      status: { phase: 'Running', containerStatuses: [{ name: 'a', ready: true }, { name: 'b' }] },
    });
    expect(podSummary(pod).ready).toBe('1/2');
  });

  it('handles a pod without any status', () => {
    expect(podSummary(kobj())).toEqual({ ready: '0/0', status: 'Unknown', restarts: 0, node: undefined });
  });

  it('caches per object identity', () => {
    const pod = kobj({ status: { phase: 'Running' } });
    expect(podSummary(pod)).toBe(podSummary(pod));
  });
});

describe('workloadReady', () => {
  it('reads readyReplicas against spec replicas', () => {
    expect(workloadReady(kobj({ spec: { replicas: 3 }, status: { readyReplicas: 2 } }))).toBe('2/3');
  });

  it('falls back to status replicas when the spec has none', () => {
    expect(workloadReady(kobj({ status: { readyReplicas: 1, replicas: 2 } }))).toBe('1/2');
  });

  it('defaults to zero', () => {
    expect(workloadReady(kobj())).toBe('0/0');
  });
});

describe('nodeStatus', () => {
  it('reports Ready when the Ready condition is True', () => {
    expect(nodeStatus(kobj({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }))).toBe('Ready');
  });

  it('reports NotReady otherwise', () => {
    expect(nodeStatus(kobj({ status: { conditions: [{ type: 'Ready', status: 'False' }] } }))).toBe('NotReady');
    expect(nodeStatus(kobj({ status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } }))).toBe('NotReady');
    expect(nodeStatus(kobj())).toBe('NotReady');
  });

  it('appends SchedulingDisabled for cordoned nodes', () => {
    const node = kobj({ spec: { unschedulable: true }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
    expect(nodeStatus(node)).toBe('Ready,SchedulingDisabled');
    expect(nodeStatus(kobj({ spec: { unschedulable: true } }))).toBe('NotReady,SchedulingDisabled');
  });
});

describe('nodeRoles', () => {
  it('extracts node-role labels', () => {
    const node = kobj({}, {
      labels: {
        'node-role.kubernetes.io/control-plane': '',
        'node-role.kubernetes.io/worker': '',
        'kubernetes.io/hostname': 'n1',
      },
    });
    expect(nodeRoles(node)).toBe('control-plane,worker');
  });

  it('is empty without role labels', () => {
    expect(nodeRoles(kobj())).toBe('');
  });
});

describe('nodeTaints', () => {
  it('formats key, optional value and effect', () => {
    const node = kobj({
      spec: {
        taints: [
          { key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' },
          { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' },
          { key: 'bare' },
        ],
      },
    });
    expect(nodeTaints(node)).toBe('node.kubernetes.io/unreachable:NoExecute, dedicated=gpu:NoSchedule, bare');
  });

  it('drops empty taints and handles none', () => {
    expect(nodeTaints(kobj({ spec: { taints: [{}] } }))).toBe('');
    expect(nodeTaints(kobj())).toBe('');
  });
});

describe('nodeConditions', () => {
  it('is empty when all conditions are in their good state', () => {
    const node = kobj({
      status: {
        conditions: [
          { type: 'Ready', status: 'True' },
          { type: 'MemoryPressure', status: 'False' },
          { type: 'DiskPressure', status: 'False' },
        ],
      },
    });
    expect(nodeConditions(node)).toBe('');
  });

  it('lists conditions that deviate from their good state', () => {
    const node = kobj({
      status: {
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'DiskPressure', status: 'True' },
          { type: 'PIDPressure', status: 'Unknown' },
        ],
      },
    });
    expect(nodeConditions(node)).toBe('Ready=False, DiskPressure=True, PIDPressure=Unknown');
  });
});

describe('hpaProblems', () => {
  it('is empty when scaling is healthy', () => {
    const hpa = kobj({
      status: {
        conditions: [
          { type: 'AbleToScale', status: 'True' },
          { type: 'ScalingActive', status: 'True' },
          { type: 'ScalingLimited', status: 'False' },
        ],
      },
    });
    expect(hpaProblems(hpa)).toBe('');
  });

  it('flags AbleToScale / ScalingActive when False, with the reason', () => {
    const hpa = kobj({
      status: {
        conditions: [
          { type: 'AbleToScale', status: 'False', reason: 'FailedGetScale' },
          { type: 'ScalingActive', status: 'False' },
        ],
      },
    });
    expect(hpaProblems(hpa)).toBe('AbleToScale (FailedGetScale), ScalingActive');
  });

  it('flags ScalingLimited when True', () => {
    const hpa = kobj({ status: { conditions: [{ type: 'ScalingLimited', status: 'True', reason: 'TooManyReplicas' }] } });
    expect(hpaProblems(hpa)).toBe('ScalingLimited (TooManyReplicas)');
  });
});

describe('servicePorts', () => {
  it('formats port, node port and protocol', () => {
    const svc = kobj({
      spec: {
        ports: [
          { port: 80, protocol: 'TCP' },
          { port: 443 },
          { port: 53, protocol: 'UDP', nodePort: 30053 },
        ],
      },
    });
    expect(servicePorts(svc)).toBe('80/TCP, 443/TCP, 53:30053/UDP');
  });

  it('is empty without ports', () => {
    expect(servicePorts(kobj())).toBe('');
  });
});

describe('ingressHosts', () => {
  it('lists hosts, substituting * for wildcard rules', () => {
    expect(ingressHosts(kobj({ spec: { rules: [{ host: 'a.example.com' }, {}] } }))).toBe('a.example.com, *');
    expect(ingressHosts(kobj())).toBe('');
  });
});

describe('jobPhase', () => {
  it('reports terminal conditions first', () => {
    const failed = kobj({
      status: {
        conditions: [
          { type: 'Failed', status: 'True' },
          { type: 'Complete', status: 'True' },
        ],
      },
    });
    expect(jobPhase(failed)).toBe('Failed');
    expect(jobPhase(kobj({ status: { conditions: [{ type: 'Complete', status: 'True' }] } }))).toBe('Complete');
  });

  it('ignores conditions that are not True', () => {
    expect(jobPhase(kobj({ status: { conditions: [{ type: 'Failed', status: 'False' }] } }))).toBe('Pending');
  });

  it('lets suspension beat activity', () => {
    expect(jobPhase(kobj({ spec: { suspend: true }, status: { active: 2 } }))).toBe('Suspended');
  });

  it('reports Running while active and Pending otherwise', () => {
    expect(jobPhase(kobj({ status: { active: 1 } }))).toBe('Running');
    expect(jobPhase(kobj())).toBe('Pending');
  });
});

describe('jobStatus', () => {
  it('formats completions with defaults', () => {
    expect(jobStatus(kobj({ spec: { completions: 3 }, status: { succeeded: 2 } })).completions).toBe('2/3');
    expect(jobStatus(kobj()).completions).toBe('0/1');
  });

  it('formats durations at second, minute and hour granularity', () => {
    const withTimes = (completionTime: string) =>
      kobj({ status: { startTime: '2026-07-22T10:00:00Z', completionTime } });
    expect(jobStatus(withTimes('2026-07-22T10:00:45Z')).duration).toBe('45s');
    expect(jobStatus(withTimes('2026-07-22T10:02:05Z')).duration).toBe('2m5s');
    expect(jobStatus(withTimes('2026-07-22T11:01:00Z')).duration).toBe('1h1m');
  });

  it('is empty without a start time', () => {
    expect(jobStatus(kobj()).duration).toBe('');
  });

  it('measures a running job against the current time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-22T10:00:30Z'));
      expect(jobStatus(kobj({ status: { startTime: '2026-07-22T10:00:00Z' } })).duration).toBe('30s');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('podRequestTotals', () => {
  const container = (cpu?: string, memory?: string, restartPolicy?: string) => ({
    restartPolicy,
    resources: { requests: { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } },
  });

  it('sums app container requests', () => {
    const pod = kobj({ spec: { containers: [container('100m', '128Mi'), container('200m', '64Mi')] } });
    expect(podRequestTotals(pod)).toEqual({ cpuMilli: 300, memoryBytes: 192 * 2 ** 20 });
  });

  it('takes the max of app containers and the largest init container', () => {
    const bigInit = kobj({
      spec: {
        containers: [container('100m', '128Mi'), container('200m', '64Mi')],
        initContainers: [container('500m', '256Mi')],
      },
    });
    expect(podRequestTotals(bigInit)).toEqual({ cpuMilli: 500, memoryBytes: 256 * 2 ** 20 });

    const smallInit = kobj({
      spec: { containers: [container('300m', '192Mi')], initContainers: [container('100m', '64Mi')] },
    });
    expect(podRequestTotals(smallInit)).toEqual({ cpuMilli: 300, memoryBytes: 192 * 2 ** 20 });
  });

  it('uses the max across init containers, not their sum', () => {
    const pod = kobj({
      spec: { containers: [], initContainers: [container('500m', '64Mi'), container('400m', '128Mi')] },
    });
    expect(podRequestTotals(pod)).toEqual({ cpuMilli: 500, memoryBytes: 128 * 2 ** 20 });
  });

  it('adds restartable init containers (sidecars) on top', () => {
    const pod = kobj({
      spec: {
        containers: [container('300m', '192Mi')],
        initContainers: [container('500m', '128Mi'), container('50m', '32Mi', 'Always')],
      },
    });
    expect(podRequestTotals(pod)).toEqual({ cpuMilli: 550, memoryBytes: (192 + 32) * 2 ** 20 });
  });

  it('adds pod overhead', () => {
    const pod = kobj({
      spec: { containers: [container('100m', '64Mi')], overhead: { cpu: '10m', memory: '1Mi' } },
    });
    expect(podRequestTotals(pod)).toEqual({ cpuMilli: 110, memoryBytes: 65 * 2 ** 20 });
  });

  it('handles pods without any requests', () => {
    expect(podRequestTotals(kobj())).toEqual({ cpuMilli: 0, memoryBytes: 0 });
    expect(podRequestTotals(kobj({ spec: { containers: [{ resources: {} }] } }))).toEqual({
      cpuMilli: 0,
      memoryBytes: 0,
    });
  });

  it('caches per object identity', () => {
    const pod = kobj({ spec: { containers: [container('100m')] } });
    expect(podRequestTotals(pod)).toBe(podRequestTotals(pod));
  });
});

describe('normalizeForDiff', () => {
  const source = () =>
    ({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'cm',
        namespace: 'prod',
        uid: 'u1',
        resourceVersion: '42',
        creationTimestamp: '2026-01-01T00:00:00Z',
        generation: 3,
        selfLink: '/api/v1/x',
        managedFields: [{ manager: 'kubectl' }],
        labels: { app: 'demo' },
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{}',
          keep: 'me',
        },
      },
      data: { k: 'v' },
      status: { phase: 'Active' },
    }) as unknown as KubeObject;

  it('strips status and noisy metadata', () => {
    const out = normalizeForDiff(source());
    expect(out.status).toBeUndefined();
    const meta = out.metadata as unknown as Record<string, unknown>;
    expect(meta.uid).toBeUndefined();
    expect(meta.resourceVersion).toBeUndefined();
    expect(meta.creationTimestamp).toBeUndefined();
    expect(meta.generation).toBeUndefined();
    expect(meta.managedFields).toBeUndefined();
    expect(meta.selfLink).toBeUndefined();
    expect(out.metadata.name).toBe('cm');
    expect(out.metadata.labels).toEqual({ app: 'demo' });
    expect(out.data).toEqual({ k: 'v' });
  });

  it('drops the last-applied annotation but keeps others', () => {
    expect(normalizeForDiff(source()).metadata.annotations).toEqual({ keep: 'me' });
  });

  it('removes the annotation map entirely when it becomes empty', () => {
    const obj = source();
    obj.metadata.annotations = { 'kubectl.kubernetes.io/last-applied-configuration': '{}' };
    expect(normalizeForDiff(obj).metadata.annotations).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const obj = source();
    normalizeForDiff(obj);
    expect(obj.status).toEqual({ phase: 'Active' });
    expect(obj.metadata.uid).toBe('u1');
    expect(obj.metadata.annotations).toHaveProperty('kubectl.kubernetes.io/last-applied-configuration');
  });
});

describe('statusLikeName', () => {
  it('accepts health-like last words in any casing style', () => {
    for (const name of [
      'Ready',
      'readiness',
      'Status',
      'Phase',
      'Health',
      'healthy',
      'Available',
      'Robustness',
      'Operational State',
      'operationalState',
      'npp-state',
      'sync_status',
      'STATE',
    ]) {
      expect(statusLikeName(name)).toBe(true);
    }
  });

  it('rejects other names', () => {
    for (const name of ['Name', 'Age', 'Replicas', 'CPU', 'stateful', 'status-reason', '']) {
      expect(statusLikeName(name)).toBe(false);
    }
  });
});
