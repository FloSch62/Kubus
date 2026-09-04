import type { KubeObject } from '@kubus/shared';
import { describe, expect, it } from 'vitest';
import { aggregateSignals, signalKey } from '../../../server/src/kube/signals';

const NOW = Date.parse('2026-09-04T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function event(fields: Record<string, unknown>): KubeObject {
  return { apiVersion: 'v1', kind: 'Event', metadata: { name: `e-${Math.random()}`, namespace: 'apps', uid: `${Math.random()}` }, ...fields } as KubeObject;
}

describe('aggregateSignals', () => {
  it('groups warning events per involved object, dedupes by reason and keeps the newest message', () => {
    const events = [
      event({ type: 'Warning', reason: 'FailedMount', message: 'old', count: 2, lastTimestamp: minutesAgo(30), involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'apps' } }),
      event({ type: 'Warning', reason: 'FailedMount', message: 'new', count: 3, lastTimestamp: minutesAgo(5), involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'apps' } }),
      event({ type: 'Warning', reason: 'BackOff', message: 'crash', lastTimestamp: minutesAgo(1), involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'apps' } }),
      event({ type: 'Normal', reason: 'Pulled', message: 'ok', lastTimestamp: minutesAgo(1), involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'apps' } }),
      event({ type: 'Warning', reason: 'Stale', message: 'too old', lastTimestamp: minutesAgo(90), involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'apps' } }),
      event({ type: 'Warning', reason: 'NodeNotReady', message: 'kubelet down', eventTime: minutesAgo(2), involvedObject: { kind: 'Node', name: 'worker-1' } }),
    ];
    const signals = aggregateSignals(events, [], NOW);
    expect(signals.windowMs).toBe(60 * 60 * 1000);
    const pod = signals.objects[signalKey('Pod', 'apps', 'web-1')];
    expect(pod?.warnings).toEqual([
      { reason: 'BackOff', message: 'crash', count: 1, lastTimestamp: minutesAgo(1) },
      { reason: 'FailedMount', message: 'new', count: 5, lastTimestamp: minutesAgo(5) },
    ]);
    // Cluster-scoped objects key with an empty namespace; the event's own namespace is not used.
    expect(signals.objects['Node||worker-1']?.warnings[0]).toMatchObject({ reason: 'NodeNotReady' });
    expect(Object.keys(signals.objects)).toHaveLength(2);
  });

  it('records recent container restarts on pods', () => {
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'api-0', namespace: 'apps', uid: 'api-0' },
      status: {
        containerStatuses: [
          { name: 'api', restartCount: 4, lastState: { terminated: { reason: 'OOMKilled', finishedAt: minutesAgo(10) } } },
          { name: 'sidecar', restartCount: 1, lastState: { terminated: { reason: 'Error', finishedAt: minutesAgo(120) } } },
          { name: 'never', restartCount: 0, lastState: { terminated: { finishedAt: minutesAgo(1) } } },
        ],
      },
    } as unknown as KubeObject;
    const signals = aggregateSignals([], [pod], NOW);
    expect(signals.objects[signalKey('Pod', 'apps', 'api-0')]).toEqual({
      warnings: [],
      restarts: [{ container: 'api', restarts: 4, reason: 'OOMKilled', finishedAt: minutesAgo(10) }],
    });
  });

  it('ignores events without an involved object or with unparsable times', () => {
    const events = [
      event({ type: 'Warning', reason: 'X', message: 'no object', lastTimestamp: minutesAgo(1) }),
      event({ type: 'Warning', reason: 'Y', message: 'bad time', lastTimestamp: 'yesterday', involvedObject: { kind: 'Pod', name: 'p', namespace: 'apps' } }),
    ];
    expect(aggregateSignals(events, [], NOW).objects).toEqual({});
  });
});
