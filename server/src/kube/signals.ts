import type { ClusterSignals, KubeObject, ObjectSignal } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';

/**
 * Attention signals per object — the data the overview's "warning events"
 * and "recent restarts" panels already collect, keyed so list rows and page
 * tabs can put a marker on the exact object it concerns. Read from the
 * pinned event and pod watcher caches; no API calls.
 */

export const SIGNAL_WINDOW_MS = 60 * 60 * 1000;

interface EventShape extends KubeObject {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  firstTimestamp?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string };
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
  lastState?: { terminated?: { reason?: string; finishedAt?: string } };
}

export function signalKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}|${namespace ?? ''}|${name}`;
}

function eventTime(e: EventShape): string {
  return e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp ?? '';
}

/** Pure aggregation over cached events and pods, exported for tests. */
export function aggregateSignals(events: KubeObject[], pods: KubeObject[], now: number, windowMs = SIGNAL_WINDOW_MS): ClusterSignals {
  const objects: Record<string, ObjectSignal> = {};
  const signalFor = (key: string): ObjectSignal => (objects[key] ??= { warnings: [] });

  for (const raw of events) {
    const e = raw as EventShape;
    if (e.type !== 'Warning' || !e.involvedObject?.kind || !e.involvedObject.name) continue;
    const time = eventTime(e);
    const t = Date.parse(time);
    if (Number.isNaN(t) || now - t >= windowMs) continue;
    // Cluster-scoped objects carry no involvedObject.namespace even though
    // the event itself lives in one — key on the object's own scope.
    const key = signalKey(e.involvedObject.kind, e.involvedObject.namespace || undefined, e.involvedObject.name);
    const signal = signalFor(key);
    const reason = e.reason ?? 'Warning';
    const uid = e.involvedObject.uid;
    // An Event's counter spans the series' lifetime; only its latest
    // occurrence is dated, so each series counts once and the counter is
    // carried as the total. A recreated object gets its own entry.
    const existing = signal.warnings.find((w) => w.reason === reason && w.uid === uid);
    if (existing) {
      existing.count += 1;
      existing.total = (existing.total ?? 0) + (e.count ?? 1);
      if (!existing.lastTimestamp || time > existing.lastTimestamp) {
        existing.lastTimestamp = time;
        existing.message = e.message ?? existing.message;
      }
    } else {
      signal.warnings.push({ reason, message: e.message ?? '', count: 1, total: e.count ?? 1, lastTimestamp: time || undefined, ...(uid ? { uid } : {}) });
    }
  }

  for (const pod of pods) {
    const statuses = (pod.status as { containerStatuses?: ContainerStatus[] } | undefined)?.containerStatuses ?? [];
    for (const c of statuses) {
      const finishedAt = c.lastState?.terminated?.finishedAt;
      if (!finishedAt || (c.restartCount ?? 0) === 0) continue;
      const t = Date.parse(finishedAt);
      if (Number.isNaN(t) || now - t >= windowMs) continue;
      const signal = signalFor(signalKey('Pod', pod.metadata.namespace, pod.metadata.name));
      // restartCount is the container's lifetime counter; only the last
      // termination is dated, so exactly one restart is known to be recent.
      (signal.restarts ??= []).push({ container: c.name, restarts: 1, total: c.restartCount ?? 0, reason: c.lastState?.terminated?.reason, finishedAt });
    }
  }

  for (const signal of Object.values(objects)) {
    signal.warnings.sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));
  }
  return { windowMs, objects };
}

export async function computeClusterSignals(handle: ClusterHandle): Promise<ClusterSignals> {
  const events = handle.watchers.acquire('', 'v1', 'events');
  const pods = handle.watchers.acquire('', 'v1', 'pods');
  try {
    await Promise.all([events.watcher.ready(), pods.watcher.ready()]);
    return aggregateSignals(events.watcher.items(), pods.watcher.items(), Date.now());
  } finally {
    events.release();
    pods.release();
  }
}
