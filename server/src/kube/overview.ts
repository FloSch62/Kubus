import type { ClusterOverview, KubeObject } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';

const RECENT_MS = 60 * 60 * 1000; // 1h window for restarts/events

interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string } };
  lastState?: { terminated?: { reason?: string; finishedAt?: string } };
}

const FAILING_WAIT_REASONS = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName', 'RunContainerError']);

/** Compute the health dashboard from already-cached watcher state — no API calls. */
export async function computeOverview(handle: ClusterHandle): Promise<ClusterOverview> {
  const podsWatcher = handle.watchers.acquire('', 'v1', 'pods');
  const deploysWatcher = handle.watchers.acquire('apps', 'v1', 'deployments');
  const eventsWatcher = handle.watchers.acquire('', 'v1', 'events');
  const nodesWatcher = handle.watchers.acquire('', 'v1', 'nodes');
  const namespacesWatcher = handle.watchers.acquire('', 'v1', 'namespaces');
  try {
    await Promise.all([podsWatcher.watcher.ready(), deploysWatcher.watcher.ready(), eventsWatcher.watcher.ready(), nodesWatcher.watcher.ready(), namespacesWatcher.watcher.ready()]);
    const pods = podsWatcher.watcher.items();
    const deployments = deploysWatcher.watcher.items();
    const events = eventsWatcher.watcher.items();

    const overview: ClusterOverview = {
      counts: {
        nodes: nodesWatcher.watcher.items().length,
        namespaces: namespacesWatcher.watcher.items().length,
        pods: pods.length,
        podsRunning: pods.filter((p) => (p.status as { phase?: string })?.phase === 'Running').length,
        deployments: deployments.length,
      },
      failingPods: [],
      unavailableWorkloads: [],
      recentRestarts: [],
      warningEvents: [],
    };

    const now = Date.now();
    for (const pod of pods) {
      const status = pod.status as { phase?: string; reason?: string; message?: string; containerStatuses?: ContainerStatus[] } | undefined;
      const statuses = status?.containerStatuses ?? [];
      const restarts = statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

      let reason: string | undefined;
      let message: string | undefined;
      if (status?.phase === 'Failed') {
        reason = status.reason ?? 'Failed';
        message = status.message;
      } else {
        for (const c of statuses) {
          const waiting = c.state?.waiting;
          if (waiting?.reason && FAILING_WAIT_REASONS.has(waiting.reason)) {
            reason = waiting.reason;
            message = waiting.message;
            break;
          }
        }
      }
      // Pending too long (unschedulable) also counts as failing.
      if (!reason && status?.phase === 'Pending') {
        const created = Date.parse(pod.metadata.creationTimestamp ?? '');
        if (!Number.isNaN(created) && now - created > 5 * 60 * 1000) {
          reason = 'Pending';
        }
      }
      if (reason) {
        overview.failingPods.push({
          namespace: pod.metadata.namespace ?? '',
          name: pod.metadata.name,
          reason,
          message,
          restarts,
        });
      }

      for (const c of statuses) {
        const finishedAt = c.lastState?.terminated?.finishedAt;
        if (finishedAt && now - Date.parse(finishedAt) < RECENT_MS && (c.restartCount ?? 0) > 0) {
          overview.recentRestarts.push({
            namespace: pod.metadata.namespace ?? '',
            pod: pod.metadata.name,
            container: c.name,
            restarts: c.restartCount ?? 0,
            finishedAt,
            reason: c.lastState?.terminated?.reason,
          });
        }
      }
    }

    for (const d of deployments) {
      const spec = d.spec as { replicas?: number } | undefined;
      const status = d.status as { availableReplicas?: number } | undefined;
      const desired = spec?.replicas ?? 1;
      const available = status?.availableReplicas ?? 0;
      if (desired > 0 && available < desired) {
        overview.unavailableWorkloads.push({
          kind: 'Deployment',
          namespace: d.metadata.namespace ?? '',
          name: d.metadata.name,
          ready: available,
          desired,
        });
      }
    }

    overview.warningEvents = events
      .filter((e) => isRecentWarning(e, now))
      .sort((a, b) => eventTime(b).localeCompare(eventTime(a)))
      .slice(0, 50)
      .map((e) => {
        const ev = e as KubeObject & {
          reason?: string;
          message?: string;
          count?: number;
          lastTimestamp?: string;
          involvedObject?: { kind?: string; name?: string };
        };
        return {
          namespace: e.metadata.namespace ?? '',
          reason: ev.reason ?? '',
          message: ev.message ?? '',
          involvedKind: ev.involvedObject?.kind ?? '',
          involvedName: ev.involvedObject?.name ?? '',
          count: ev.count ?? 1,
          lastTimestamp: eventTime(e) || undefined,
        };
      });

    overview.failingPods.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
    overview.recentRestarts.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return overview;
  } finally {
    podsWatcher.release();
    deploysWatcher.release();
    eventsWatcher.release();
    nodesWatcher.release();
    namespacesWatcher.release();
  }
}

function eventTime(e: KubeObject): string {
  const ev = e as KubeObject & { lastTimestamp?: string; eventTime?: string; firstTimestamp?: string };
  return ev.lastTimestamp ?? ev.eventTime ?? ev.firstTimestamp ?? e.metadata.creationTimestamp ?? '';
}

function isRecentWarning(e: KubeObject, now: number): boolean {
  if ((e as { type?: string }).type !== 'Warning') return false;
  const t = Date.parse(eventTime(e));
  return !Number.isNaN(t) && now - t < RECENT_MS;
}
