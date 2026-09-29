import type { KubeObject } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import type { EventsScope } from '../state/events-prefs.js';

export interface EventObj extends KubeObject {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string | null;
  firstTimestamp?: string | null;
  eventTime?: string | null;
  series?: { count?: number; lastObservedTime?: string | null };
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string; apiVersion?: string };
}

export interface EventRow {
  id: string;
  ctx: string;
  ev: EventObj;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
}

function maxTime(...ts: Array<string | null | undefined>): string | undefined {
  return ts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .at(-1);
}

function minTime(...ts: Array<string | null | undefined>): string | undefined {
  return ts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .at(0);
}

function involvedKey(ctx: string, ev: EventObj): string {
  const o = ev.involvedObject;
  return `${ctx}|${o?.uid ?? `${o?.kind}/${o?.namespace}/${o?.name}`}`;
}

/** Merge repeated events: same cluster, involved object, reason and message. */
export function dedupeEvents(rows: ClusterRow[]): EventRow[] {
  const out = new Map<string, EventRow>();
  for (const { ctx, obj } of rows) {
    const ev = obj as EventObj;
    const key = `${involvedKey(ctx, ev)}|${ev.reason ?? ''}|${ev.message ?? ''}`;
    const count = ev.count ?? ev.series?.count ?? 1;
    const last = maxTime(ev.lastTimestamp, ev.eventTime, ev.series?.lastObservedTime, obj.metadata.creationTimestamp);
    const first = minTime(ev.firstTimestamp, ev.eventTime, obj.metadata.creationTimestamp);
    const existing = out.get(key);
    if (!existing) {
      out.set(key, { id: key, ctx, ev, count, firstSeen: first, lastSeen: last });
    } else {
      // Distinct event objects under the same key (each uid appears once per
      // snapshot) — their counts add up.
      existing.count += count;
      existing.firstSeen = minTime(existing.firstSeen, first);
      const newer = maxTime(existing.lastSeen, last) === last;
      existing.lastSeen = maxTime(existing.lastSeen, last);
      if (newer) existing.ev = ev;
    }
  }
  return [...out.values()];
}

export const isWarning = (row: EventRow) => row.ev.type === 'Warning';

/** Every event about one involved object, summarised for the grouped view. */
export interface ObjectGroup {
  id: string;
  ctx: string;
  object: NonNullable<EventObj['involvedObject']>;
  /** The event the row leads with: the newest warning, or the newest event when there is none. */
  latest: EventRow;
  /** Events counted in this view (warnings only in the Warnings view). */
  count: number;
  /** The events the Count and activity cover, newest first. */
  counted: EventRow[];
  /** The object's other events, newest first (folded under the lead event). */
  related: EventRow[];
  lastSeen?: string;
}

function byLastSeenDesc(a: EventRow, b: EventRow): number {
  return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '');
}

/**
 * One row per involved object. The Warnings scope keeps only objects with at
 * least one warning and counts only warnings; the object's Normal events stay
 * reachable as folded "related" events.
 */
export function groupEventsByObject(rows: EventRow[], scope: EventsScope): ObjectGroup[] {
  const byObject = new Map<string, EventRow[]>();
  for (const row of rows) {
    const key = involvedKey(row.ctx, row.ev);
    const list = byObject.get(key);
    if (list) list.push(row);
    else byObject.set(key, [row]);
  }
  const out: ObjectGroup[] = [];
  for (const [id, events] of byObject) {
    events.sort(byLastSeenDesc);
    const warnings = events.filter(isWarning);
    if (scope === 'warnings' && warnings.length === 0) continue;
    const counted = scope === 'warnings' ? warnings : events;
    const latest = warnings[0] ?? events[0]!;
    out.push({
      id,
      ctx: latest.ctx,
      object: latest.ev.involvedObject ?? {},
      latest,
      count: counted.reduce((sum, e) => sum + e.count, 0),
      counted,
      related: events.filter((e) => e !== latest),
      lastSeen: counted[0]?.lastSeen,
    });
  }
  return out;
}

/**
 * Estimated events per bucket over the last `windowMs` (oldest bucket first).
 * An event only records its first and last occurrence plus a count, so each
 * one's count is spread evenly across that span; the shape shows when the
 * object was busy, not exact timings.
 */
export function activityBuckets(events: EventRow[], nowMs: number, buckets = 12, windowMs = 60 * 60 * 1000): number[] {
  const out = Array.from({ length: buckets }, () => 0);
  const start = nowMs - windowMs;
  const size = windowMs / buckets;
  for (const e of events) {
    const last = e.lastSeen ? Date.parse(e.lastSeen) : NaN;
    if (!Number.isFinite(last) || last < start) continue;
    const firstRaw = e.firstSeen ? Date.parse(e.firstSeen) : last;
    const first = Number.isFinite(firstRaw) ? Math.min(firstRaw, last) : last;
    if (last - first < size) {
      const i = Math.min(buckets - 1, Math.max(0, Math.floor((last - start) / size)));
      out[i]! += e.count;
      continue;
    }
    const density = e.count / (last - first);
    for (let i = 0; i < buckets; i++) {
      const bs = start + i * size;
      const overlap = Math.min(bs + size, last) - Math.max(bs, first);
      if (overlap > 0) out[i]! += density * overlap;
    }
  }
  return out;
}

function compactCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** "BackOff ×1.5k · Pulling ×72 · +2 more" — the object's other events, by reason. */
export function relatedSummary(related: EventRow[], max = 3): string {
  const byReason = new Map<string, number>();
  for (const e of related) {
    const reason = e.ev.reason || 'Event';
    byReason.set(reason, (byReason.get(reason) ?? 0) + e.count);
  }
  const entries = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, max).map(([reason, count]) => (count > 1 ? `${reason} ×${compactCount(count)}` : reason));
  if (entries.length > max) shown.push(`+${entries.length - max} more`);
  return shown.join(' · ');
}
