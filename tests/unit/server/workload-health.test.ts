import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  HEALTH_KINDS,
  type HealthKindItems,
  computeWorkloadHealth,
  latestJobsByCronJob,
} from '../../../server/src/kube/workload-health.js';

function specFor(kind: string) {
  const spec = HEALTH_KINDS.find((k) => k.kind === kind);
  if (!spec) throw new Error(`unknown kind ${kind}`);
  return spec;
}

let uidSeq = 0;
function obj(
  name: string,
  body: { namespace?: string; spec?: Record<string, unknown>; status?: Record<string, unknown>; meta?: Record<string, unknown> } = {},
): KubeObject {
  return {
    metadata: { name, namespace: body.namespace ?? 'ns', uid: `uid-${uidSeq++}`, ...body.meta },
    ...(body.spec ? { spec: body.spec } : {}),
    ...(body.status ? { status: body.status } : {}),
  } as KubeObject;
}

function check(kind: string, items: KubeObject[], jobs?: KubeObject[]) {
  const input: HealthKindItems[] = [{ spec: specFor(kind), items, unavailable: false }];
  if (jobs) input.unshift({ spec: specFor('Job'), items: jobs, unavailable: false });
  const result = computeWorkloadHealth(input);
  return { ...result, kindIssues: result.issues.filter((i) => i.kind === kind) };
}

function cronOwnedJob(name: string, owner: string, ts: string, opts: { failed?: boolean; message?: string; namespace?: string } = {}): KubeObject {
  return obj(name, {
    namespace: opts.namespace,
    meta: {
      creationTimestamp: ts,
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: owner, uid: 'cj-uid' }],
    },
    status: opts.failed
      ? { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', ...(opts.message ? { message: opts.message } : {}) }] }
      : { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
  });
}

describe('latestJobsByCronJob', () => {
  it('keeps the newest job per owning cronjob', () => {
    const older = cronOwnedJob('backup-1', 'backup', '2026-07-01T00:00:00Z');
    const newer = cronOwnedJob('backup-2', 'backup', '2026-07-02T00:00:00Z');
    const latest = latestJobsByCronJob([newer, older]);
    expect(latest.get('ns/backup')).toBe(newer);
    expect(latest.size).toBe(1);
  });

  it('ignores jobs not owned by a cronjob', () => {
    const standalone = obj('one-off', { meta: { creationTimestamp: '2026-07-01T00:00:00Z' } });
    const otherOwner = obj('child', {
      meta: { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'd' }] },
    });
    expect(latestJobsByCronJob([standalone, otherOwner]).size).toBe(0);
  });

  it('keys by namespace so same-named cronjobs stay separate', () => {
    const a = cronOwnedJob('sync-1', 'sync', '2026-07-01T00:00:00Z', { namespace: 'team-a' });
    const b = cronOwnedJob('sync-9', 'sync', '2026-07-03T00:00:00Z', { namespace: 'team-b' });
    const latest = latestJobsByCronJob([a, b]);
    expect(latest.get('team-a/sync')).toBe(a);
    expect(latest.get('team-b/sync')).toBe(b);
  });
});

describe('computeWorkloadHealth: Deployment', () => {
  it('flags fewer available than desired replicas', () => {
    const bad = obj('web', { spec: { replicas: 3 }, status: { availableReplicas: 1 } });
    const ok = obj('api', { spec: { replicas: 2 }, status: { availableReplicas: 2 } });
    const { kinds, issues } = check('Deployment', [ok, bad]);
    expect(kinds[0]).toMatchObject({ kind: 'Deployment', group: 'apps', total: 2, unhealthy: 1 });
    expect(issues).toEqual([{ kind: 'Deployment', namespace: 'ns', name: 'web', ready: 1, desired: 3, reason: 'Unavailable' }]);
  });

  it('treats scaled-to-zero as healthy', () => {
    const { issues } = check('Deployment', [obj('paused', { spec: { replicas: 0 }, status: { availableReplicas: 0 } })]);
    expect(issues).toEqual([]);
  });

  it('defaults desired to 1 and ready to 0 when fields are missing', () => {
    const { issues } = check('Deployment', [obj('bare')]);
    expect(issues).toEqual([{ kind: 'Deployment', namespace: 'ns', name: 'bare', ready: 0, desired: 1, reason: 'Unavailable' }]);
  });
});

describe('computeWorkloadHealth: StatefulSet', () => {
  it('uses readyReplicas against spec.replicas', () => {
    const ok = obj('db', { spec: { replicas: 3 }, status: { readyReplicas: 3 } });
    const bad = obj('cache', { spec: { replicas: 3 }, status: { readyReplicas: 2 } });
    const { issues } = check('StatefulSet', [ok, bad]);
    expect(issues).toEqual([{ kind: 'StatefulSet', namespace: 'ns', name: 'cache', ready: 2, desired: 3, reason: 'Unavailable' }]);
  });
});

describe('computeWorkloadHealth: DaemonSet', () => {
  it('flags pods not ready on all scheduled nodes', () => {
    const bad = obj('agent', { status: { desiredNumberScheduled: 4, numberReady: 3 } });
    const { issues } = check('DaemonSet', [bad]);
    expect(issues).toEqual([{ kind: 'DaemonSet', namespace: 'ns', name: 'agent', ready: 3, desired: 4, reason: 'Unavailable' }]);
  });

  it('is healthy with zero scheduled nodes', () => {
    const { issues } = check('DaemonSet', [obj('agent', { status: { desiredNumberScheduled: 0, numberReady: 0 } })]);
    expect(issues).toEqual([]);
  });
});

describe('computeWorkloadHealth: Job', () => {
  it('flags jobs with a Failed=True condition', () => {
    const failed = obj('migrate', {
      spec: { completions: 2 },
      status: { succeeded: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'too many retries' }] },
    });
    const { issues } = check('Job', [failed]);
    expect(issues).toEqual([
      { kind: 'Job', namespace: 'ns', name: 'migrate', ready: 1, desired: 2, reason: 'BackoffLimitExceeded', message: 'too many retries' },
    ]);
  });

  it('falls back to reason Failed when the condition has none', () => {
    const failed = obj('migrate', { status: { conditions: [{ type: 'Failed', status: 'True' }] } });
    const { issues } = check('Job', [failed]);
    expect(issues[0]).toMatchObject({ ready: 0, desired: 1, reason: 'Failed' });
  });

  it('treats completed and running jobs as healthy', () => {
    const complete = obj('done', { status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } });
    const running = obj('running', { status: { active: 1 } });
    const notFailed = obj('almost', { status: { conditions: [{ type: 'Failed', status: 'False' }] } });
    expect(check('Job', [complete, running, notFailed]).issues).toEqual([]);
  });
});

describe('computeWorkloadHealth: CronJob', () => {
  it('flags a cronjob whose most recent run failed', () => {
    const cron = obj('backup');
    const jobs = [
      cronOwnedJob('backup-1', 'backup', '2026-07-01T00:00:00Z'),
      cronOwnedJob('backup-2', 'backup', '2026-07-02T00:00:00Z', { failed: true, message: 'disk full' }),
    ];
    const { kindIssues } = check('CronJob', [cron], jobs);
    expect(kindIssues).toEqual([{ kind: 'CronJob', namespace: 'ns', name: 'backup', reason: 'LastRunFailed', message: 'disk full' }]);
  });

  it('synthesizes a message naming the failed job when the condition has none', () => {
    const cron = obj('backup');
    const jobs = [cronOwnedJob('backup-7', 'backup', '2026-07-02T00:00:00Z', { failed: true })];
    const { kindIssues } = check('CronJob', [cron], jobs);
    expect(kindIssues[0]?.message).toBe('Job backup-7 failed');
  });

  it('is healthy when the latest run succeeded even if an older one failed', () => {
    const cron = obj('backup');
    const jobs = [
      cronOwnedJob('backup-1', 'backup', '2026-07-01T00:00:00Z', { failed: true }),
      cronOwnedJob('backup-2', 'backup', '2026-07-02T00:00:00Z'),
    ];
    expect(check('CronJob', [cron], jobs).kindIssues).toEqual([]);
  });

  it('ignores suspended cronjobs even with a failed latest run', () => {
    const cron = obj('backup', { spec: { suspend: true } });
    const jobs = [cronOwnedJob('backup-1', 'backup', '2026-07-01T00:00:00Z', { failed: true })];
    expect(check('CronJob', [cron], jobs).kindIssues).toEqual([]);
  });

  it('is healthy with no runs at all', () => {
    expect(check('CronJob', [obj('backup')], []).kindIssues).toEqual([]);
  });
});

describe('computeWorkloadHealth: HorizontalPodAutoscaler', () => {
  it('flags AbleToScale=False', () => {
    const hpa = obj('web-hpa', {
      status: {
        currentReplicas: 2,
        desiredReplicas: 5,
        conditions: [{ type: 'AbleToScale', status: 'False', reason: 'FailedGetScale', message: 'target not found' }],
      },
    });
    const { issues } = check('HorizontalPodAutoscaler', [hpa]);
    expect(issues).toEqual([
      {
        kind: 'HorizontalPodAutoscaler',
        namespace: 'ns',
        name: 'web-hpa',
        ready: 2,
        desired: 5,
        reason: 'FailedGetScale',
        message: 'target not found',
      },
    ]);
  });

  it('flags ScalingActive=False except when scaling is disabled', () => {
    const broken = obj('broken', {
      status: { conditions: [{ type: 'ScalingActive', status: 'False', reason: 'FailedGetResourceMetric' }] },
    });
    const disabled = obj('disabled', {
      status: { conditions: [{ type: 'ScalingActive', status: 'False', reason: 'ScalingDisabled' }] },
    });
    const { issues } = check('HorizontalPodAutoscaler', [broken, disabled]);
    expect(issues.map((i) => i.name)).toEqual(['broken']);
    expect(issues[0]?.reason).toBe('FailedGetResourceMetric');
  });

  it('falls back to the condition type when the reason is missing', () => {
    const hpa = obj('web-hpa', { status: { conditions: [{ type: 'AbleToScale', status: 'False' }] } });
    expect(check('HorizontalPodAutoscaler', [hpa]).issues[0]?.reason).toBe('AbleToScale');
  });

  it('is healthy when scaling conditions are True', () => {
    const hpa = obj('web-hpa', {
      status: {
        conditions: [
          { type: 'AbleToScale', status: 'True' },
          { type: 'ScalingActive', status: 'True' },
        ],
      },
    });
    expect(check('HorizontalPodAutoscaler', [hpa]).issues).toEqual([]);
  });
});

describe('computeWorkloadHealth: PersistentVolumeClaim', () => {
  it('treats Bound as healthy and reports other phases', () => {
    const bound = obj('data', { status: { phase: 'Bound' } });
    const pending = obj('waiting', { status: { phase: 'Pending' } });
    const lost = obj('gone', { status: { phase: 'Lost' } });
    const { issues } = check('PersistentVolumeClaim', [bound, pending, lost]);
    expect(issues).toEqual([
      { kind: 'PersistentVolumeClaim', namespace: 'ns', name: 'gone', reason: 'Lost' },
      { kind: 'PersistentVolumeClaim', namespace: 'ns', name: 'waiting', reason: 'Pending' },
    ]);
  });

  it('defaults a missing phase to Pending', () => {
    expect(check('PersistentVolumeClaim', [obj('new')]).issues[0]?.reason).toBe('Pending');
  });
});

describe('computeWorkloadHealth: PodDisruptionBudget', () => {
  it('flags budgets that allow no disruptions', () => {
    const stuck = obj('web-pdb', {
      status: { expectedPods: 3, disruptionsAllowed: 0, currentHealthy: 2, desiredHealthy: 3 },
    });
    const { issues } = check('PodDisruptionBudget', [stuck]);
    expect(issues[0]).toMatchObject({ name: 'web-pdb', ready: 2, desired: 3, reason: 'NoDisruptionsAllowed' });
  });

  it('is healthy when disruptions are allowed or no pods are expected', () => {
    const ok = obj('ok', { status: { expectedPods: 3, disruptionsAllowed: 1 } });
    const empty = obj('empty', { status: { expectedPods: 0, disruptionsAllowed: 0 } });
    const noStatus = obj('fresh');
    expect(check('PodDisruptionBudget', [ok, empty, noStatus]).issues).toEqual([]);
  });
});

describe('computeWorkloadHealth: ResourceQuota', () => {
  it('reports AtQuota when usage reaches the hard limit', () => {
    const quota = obj('compute', { status: { hard: { pods: '10' }, used: { pods: '10' } } });
    const { issues } = check('ResourceQuota', [quota]);
    expect(issues[0]).toMatchObject({ reason: 'AtQuota', message: 'pods 10/10' });
  });

  it('reports NearQuota above 90% usage, including unit quantities', () => {
    const quota = obj('mem', { status: { hard: { 'limits.memory': '1Gi' }, used: { 'limits.memory': '1000Mi' } } });
    const { issues } = check('ResourceQuota', [quota]);
    expect(issues[0]).toMatchObject({ reason: 'NearQuota', message: 'limits.memory 1000Mi/1Gi' });
  });

  it('prefers AtQuota and lists exhausted resources first', () => {
    const quota = obj('mixed', {
      status: { hard: { pods: '10', cpu: '10' }, used: { pods: '10', cpu: '9' } },
    });
    const { issues } = check('ResourceQuota', [quota]);
    expect(issues[0]).toMatchObject({ reason: 'AtQuota', message: 'pods 10/10, cpu 9/10' });
  });

  it('is healthy under 90% and skips zero hard limits', () => {
    const under = obj('roomy', { status: { hard: { pods: '10' }, used: { pods: '5' } } });
    const zero = obj('zeroed', { status: { hard: { pods: '0' }, used: { pods: '0' } } });
    const noStatus = obj('fresh');
    expect(check('ResourceQuota', [under, zero, noStatus]).issues).toEqual([]);
  });

  it('treats missing usage as zero', () => {
    const quota = obj('unused', { status: { hard: { pods: '10' } } });
    expect(check('ResourceQuota', [quota]).issues).toEqual([]);
  });
});

describe('computeWorkloadHealth: rollup', () => {
  it('emits per-kind totals in input order and sorts issues by kind/namespace/name', () => {
    const result = computeWorkloadHealth([
      {
        spec: specFor('Deployment'),
        items: [
          obj('zeta', { spec: { replicas: 1 }, status: {} }),
          obj('alpha', { spec: { replicas: 1 }, status: {} }),
          obj('fine', { spec: { replicas: 1 }, status: { availableReplicas: 1 } }),
        ],
        unavailable: false,
      },
      { spec: specFor('PersistentVolumeClaim'), items: [obj('claim', { status: { phase: 'Pending' } })], unavailable: false },
      { spec: specFor('StatefulSet'), items: [], unavailable: true },
    ]);
    expect(result.kinds.map((k) => [k.kind, k.total, k.unhealthy, k.unavailable])).toEqual([
      ['Deployment', 3, 2, undefined],
      ['PersistentVolumeClaim', 1, 1, undefined],
      ['StatefulSet', 0, 0, true],
    ]);
    expect(result.issues.map((i) => `${i.kind}/${i.name}`)).toEqual([
      'Deployment/alpha',
      'Deployment/zeta',
      'PersistentVolumeClaim/claim',
    ]);
  });
});
