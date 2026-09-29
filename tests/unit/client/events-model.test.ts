import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import type { ClusterRow } from '../../../client/src/api/queries';
import { activityBuckets, dedupeEvents, groupEventsByObject, relatedSummary, type EventRow } from '../../../client/src/pages/events-model';

let seq = 0;
function event(fields: {
  type?: string;
  reason: string;
  message?: string;
  count?: number;
  first?: string;
  last?: string;
  object?: { kind: string; name: string; namespace?: string; uid?: string };
  ctx?: string;
}): ClusterRow {
  seq += 1;
  const obj = {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `ev-${seq}`, namespace: fields.object?.namespace ?? 'demo', uid: `u-${seq}`, creationTimestamp: fields.first ?? '2026-09-29T10:00:00Z' },
    type: fields.type ?? 'Normal',
    reason: fields.reason,
    message: fields.message ?? fields.reason,
    count: fields.count ?? 1,
    firstTimestamp: fields.first ?? '2026-09-29T10:00:00Z',
    lastTimestamp: fields.last ?? fields.first ?? '2026-09-29T10:00:00Z',
    involvedObject: fields.object ?? { kind: 'Pod', name: 'web-1', namespace: 'demo', uid: 'pod-web-1' },
  } as unknown as KubeObject;
  return { ctx: fields.ctx ?? 'kind-a', obj };
}

const WEB = { kind: 'Pod', name: 'web-1', namespace: 'demo', uid: 'pod-web-1' };
const DB = { kind: 'Pod', name: 'db-0', namespace: 'demo', uid: 'pod-db-0' };

describe('dedupeEvents', () => {
  it('adds up counts of separate event objects with the same object, reason and message', () => {
    const rows = dedupeEvents([
      event({ reason: 'BackOff', count: 3, object: WEB, last: '2026-09-29T10:05:00Z' }),
      event({ reason: 'BackOff', count: 2, object: WEB, last: '2026-09-29T10:09:00Z' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(5);
    expect(rows[0]!.lastSeen).toBe('2026-09-29T10:09:00Z');
  });
});

describe('groupEventsByObject', () => {
  const rows = dedupeEvents([
    event({ type: 'Warning', reason: 'Failed', message: 'ImagePullBackOff', count: 10, object: WEB, last: '2026-09-29T10:10:00Z' }),
    event({ type: 'Normal', reason: 'BackOff', count: 12, object: WEB, last: '2026-09-29T10:11:00Z' }),
    event({ type: 'Normal', reason: 'Pulled', count: 1, object: DB, last: '2026-09-29T10:12:00Z' }),
  ]);

  it('keeps only objects with warnings in the Warnings view and leads with the warning', () => {
    const groups = groupEventsByObject(rows, 'warnings');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.object.name).toBe('web-1');
    expect(groups[0]!.latest.ev.reason).toBe('Failed');
    // Only warnings count; the Normal BackOff is folded under the row.
    expect(groups[0]!.count).toBe(10);
    expect(groups[0]!.related.map((r) => r.ev.reason)).toEqual(['BackOff']);
  });

  it('lists every object in the All view and counts every event', () => {
    const groups = groupEventsByObject(rows, 'all');
    expect(groups.map((g) => g.object.name).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['db-0', 'web-1']);
    expect(groups.find((g) => g.object.name === 'web-1')!.count).toBe(22);
  });

  it('separates the same object name in two clusters', () => {
    const two = dedupeEvents([
      event({ type: 'Warning', reason: 'Failed', object: { ...WEB, uid: undefined as unknown as string }, ctx: 'a' }),
      event({ type: 'Warning', reason: 'Failed', object: { ...WEB, uid: undefined as unknown as string }, ctx: 'b' }),
    ]);
    expect(groupEventsByObject(two, 'warnings')).toHaveLength(2);
  });
});

describe('activityBuckets', () => {
  const now = Date.parse('2026-09-29T11:00:00Z');
  const row = (count: number, first: string, last: string): EventRow => ({
    id: `${first}-${last}`,
    ctx: 'a',
    ev: { apiVersion: 'v1', kind: 'Event', metadata: { name: 'e', uid: 'e' } },
    count,
    firstSeen: first,
    lastSeen: last,
  });

  it('spreads a long-running event evenly over the part of the hour it covers', () => {
    const buckets = activityBuckets([row(120, '2026-09-29T09:00:00Z', '2026-09-29T11:00:00Z')], now);
    expect(buckets).toHaveLength(12);
    expect(buckets.every((b) => Math.abs(b - 5) < 0.001)).toBe(true);
  });

  it('puts a short burst in one bucket and ignores events older than the window', () => {
    const buckets = activityBuckets(
      [row(4, '2026-09-29T10:52:00Z', '2026-09-29T10:53:00Z'), row(9, '2026-09-29T08:00:00Z', '2026-09-29T09:30:00Z')],
      now,
    );
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(4);
    expect(buckets[10]).toBe(4);
  });
});

describe('relatedSummary', () => {
  it('lists other reasons by count and compacts large numbers', () => {
    const related = dedupeEvents([
      event({ reason: 'BackOff', count: 1521, object: WEB }),
      event({ reason: 'Pulling', count: 72, object: WEB }),
      event({ reason: 'Created', count: 1, object: WEB }),
      event({ reason: 'Started', count: 1, object: WEB }),
    ]);
    expect(relatedSummary(related)).toBe('BackOff ×1.5k · Pulling ×72 · Created · +1 more');
  });
});
