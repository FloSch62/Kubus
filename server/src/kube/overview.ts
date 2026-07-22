import type { ClusterOverview, KubeObject, OverviewWarningEvent, ResourceKindInfo } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { HEALTH_KINDS, computeWorkloadHealth, type HealthKindItems } from './workload-health.js';

const RECENT_MS = 60 * 60 * 1000; // 1h window for restarts/events

interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string } };
  lastState?: { terminated?: { reason?: string; finishedAt?: string } };
}

const FAILING_WAIT_REASONS = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName', 'RunContainerError']);

/**
 * Compute the health dashboard from already-cached watcher state — no API
 * calls. Operator rollups and certificate expiry live on their own endpoints
 * so their (slower) warmups — the all-secrets watcher, operator CR lists, the
 * API-server TLS probe — never delay the first paint of counts and health.
 */
export async function computeOverview(handle: ClusterHandle): Promise<ClusterOverview> {
  const podsWatcher = handle.watchers.acquire('', 'v1', 'pods');
  const deploysWatcher = handle.watchers.acquire('apps', 'v1', 'deployments');
  const eventsWatcher = handle.watchers.acquire('', 'v1', 'events');
  const nodesWatcher = handle.watchers.acquire('', 'v1', 'nodes');
  const namespacesWatcher = handle.watchers.acquire('', 'v1', 'namespaces');
  const pvsWatcher = handle.watchers.acquire('', 'v1', 'persistentvolumes');
  const crdsWatcher = handle.watchers.acquire('apiextensions.k8s.io', 'v1', 'customresourcedefinitions');
  // Deployments are pinned above; the remaining health kinds are acquired on
  // demand and shared with the list pages (30s linger between polls).
  const healthWatchers = HEALTH_KINDS.filter((spec) => spec.kind !== 'Deployment').map((spec) => ({
    spec,
    handle: handle.watchers.acquire(spec.group, spec.version, spec.plural),
  }));
  try {
    // Warm every watcher concurrently — the optional ones must not wait for
    // the core set to finish listing first.
    const coreReady = Promise.all([
      podsWatcher.watcher.ready(),
      deploysWatcher.watcher.ready(),
      eventsWatcher.watcher.ready(),
      nodesWatcher.watcher.ready(),
      namespacesWatcher.watcher.ready(),
    ]);
    // The rejection is re-observed at the `await coreReady` below; without this
    // parked handler a core LIST failure while the optional await is still
    // pending is an unhandled rejection and takes down the whole process.
    void coreReady.catch(() => {});
    const [persistentVolumesResult, crdsResult, ...healthResults] = await Promise.all([
      optionalItems(pvsWatcher.watcher),
      optionalItems(crdsWatcher.watcher),
      ...healthWatchers.map((w) => optionalItems(w.handle.watcher)),
    ]);
    await coreReady;
    const pods = podsWatcher.watcher.items();
    const deployments = deploysWatcher.watcher.items();
    const events = eventsWatcher.watcher.items();
    const persistentVolumes = persistentVolumesResult.items;
    const crds = crdsResult.items;
    const customResourceEntries = await handle.searchIndex.entries();
    const customResourcesIndexed = !handle.searchIndex.isReconciling();

    const overview: ClusterOverview = {
      counts: {
        nodes: nodesWatcher.watcher.items().length,
        namespaces: namespacesWatcher.watcher.items().length,
        pods: pods.length,
        podsRunning: 0,
        deployments: deployments.length,
        persistentVolumes: persistentVolumes.length,
        persistentVolumesBound: persistentVolumes.filter((pv) => (pv.status as { phase?: string } | undefined)?.phase === 'Bound').length,
        persistentVolumesUnavailable: persistentVolumesResult.unavailable,
        crds: crds.length,
        crdsEstablished: crds.filter(isEstablishedCrd).length,
        crdsUnavailable: crdsResult.unavailable,
        customResources: customResourceEntries.reduce((n, entry) => (entry.kind.custom ? n + 1 : n), 0),
        customResourcesIndexed,
      },
      failingPods: [],
      unavailableWorkloads: [],
      recentRestarts: [],
      warningEvents: [],
      workloadHealth: [],
    };

    const healthBySpec = new Map(healthWatchers.map((w, i) => [w.spec, healthResults[i] ?? { items: [], unavailable: true }]));
    const healthKinds: HealthKindItems[] = HEALTH_KINDS.map((spec) => {
      if (spec.kind === 'Deployment') return { spec, items: deployments, unavailable: false };
      const result = healthBySpec.get(spec) ?? { items: [], unavailable: true };
      return { spec, items: result.items, unavailable: result.unavailable };
    });
    const health = computeWorkloadHealth(healthKinds);
    overview.workloadHealth = health.kinds;
    overview.unavailableWorkloads = health.issues;

    const now = Date.now();
    for (const pod of pods) {
      const status = pod.status as { phase?: string; containerStatuses?: ContainerStatus[] } | undefined;
      if (status?.phase === 'Running') overview.counts.podsRunning += 1;
      const failure = podFailure(pod, now);
      if (failure) {
        overview.failingPods.push({ namespace: pod.metadata.namespace ?? '', name: pod.metadata.name, ...failure });
      }

      for (const c of status?.containerStatuses ?? []) {
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

    overview.warningEvents = collectWarningEvents(events, now, await handle.discovery.getResources().catch(() => []));

    overview.failingPods.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
    overview.recentRestarts.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return overview;
  } finally {
    podsWatcher.release();
    deploysWatcher.release();
    eventsWatcher.release();
    nodesWatcher.release();
    namespacesWatcher.release();
    pvsWatcher.release();
    crdsWatcher.release();
    for (const w of healthWatchers) w.handle.release();
  }
}

/** Failing-pod detection shared with the namespace overview. */
export function podFailure(pod: KubeObject, now: number): { reason: string; message?: string; restarts: number } | undefined {
  const status = pod.status as { phase?: string; reason?: string; message?: string; containerStatuses?: ContainerStatus[] } | undefined;
  const statuses = status?.containerStatuses ?? [];
  const restarts = statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

  if (status?.phase === 'Failed') {
    return { reason: status.reason ?? 'Failed', message: status.message, restarts };
  }
  for (const c of statuses) {
    const waiting = c.state?.waiting;
    if (waiting?.reason && FAILING_WAIT_REASONS.has(waiting.reason)) {
      return { reason: waiting.reason, message: waiting.message, restarts };
    }
  }
  // Pending too long (unschedulable) also counts as failing.
  if (status?.phase === 'Pending') {
    const created = Date.parse(pod.metadata.creationTimestamp ?? '');
    if (!Number.isNaN(created) && now - created > 5 * 60 * 1000) {
      return { reason: 'Pending', restarts };
    }
  }
  return undefined;
}

/** Warning events within the 1h window, newest first, capped at 50. */
export function collectWarningEvents(events: KubeObject[], now: number, kinds: ResourceKindInfo[] = []): OverviewWarningEvent[] {
  return events
    .flatMap((e) => {
      if ((e as { type?: string }).type !== 'Warning') return [];
      const time = eventTime(e);
      const t = Date.parse(time);
      return !Number.isNaN(t) && now - t < RECENT_MS ? [{ e, time }] : [];
    })
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 50)
    .map(({ e, time }) => {
      const ev = e as KubeObject & {
        reason?: string;
        message?: string;
        count?: number;
        lastTimestamp?: string;
        involvedObject?: { apiVersion?: string; kind?: string; name?: string };
      };
      return {
        namespace: e.metadata.namespace ?? '',
        reason: ev.reason ?? '',
        message: ev.message ?? '',
        involvedKind: ev.involvedObject?.kind ?? '',
        involvedName: ev.involvedObject?.name ?? '',
        involvedGvr: resolveInvolvedGvr(kinds, ev.involvedObject),
        count: ev.count ?? 1,
        lastTimestamp: time || undefined,
      };
    });
}

/**
 * Resolve an event's involvedObject to its list GVR via discovery, so the
 * client can deep-link it. Controllers are sloppy about apiVersion (bare
 * group, stale version, or missing entirely), so this degrades from an exact
 * group+version match down to a by-kind lookup rather than giving up.
 */
function resolveInvolvedGvr(
  kinds: ResourceKindInfo[],
  involved: { apiVersion?: string; kind?: string } | undefined,
): { group: string; version: string; plural: string; namespaced: boolean } | undefined {
  const kind = involved?.kind;
  if (!kind) return undefined;
  const byKind = kinds.filter((k) => k.kind === kind);
  if (byKind.length === 0) return undefined;
  const apiVersion = involved.apiVersion ?? '';
  let group = '';
  let version = '';
  if (apiVersion.includes('/')) [group = '', version = ''] = apiVersion.split('/');
  else if (apiVersion.includes('.')) group = apiVersion; // bare group, e.g. "core.eda.nokia.com"
  else version = apiVersion; // core-group version, e.g. "v1"
  const inGroup = group ? byKind.filter((k) => k.group === group) : byKind;
  const match =
    inGroup.find((k) => version && k.version === version) ??
    inGroup.find((k) => !k.custom) ??
    inGroup[0] ??
    byKind.find((k) => !k.custom) ??
    byKind[0];
  return match ? { group: match.group, version: match.version, plural: match.plural, namespaced: match.namespaced } : undefined;
}

function eventTime(e: KubeObject): string {
  const ev = e as KubeObject & { lastTimestamp?: string; eventTime?: string; firstTimestamp?: string };
  return ev.lastTimestamp ?? ev.eventTime ?? ev.firstTimestamp ?? e.metadata.creationTimestamp ?? '';
}

function isEstablishedCrd(crd: KubeObject): boolean {
  const conditions = (crd.status as { conditions?: Array<{ type?: string; status?: string }> } | undefined)?.conditions ?? [];
  return conditions.some((c) => c.type === 'Established' && c.status === 'True');
}

/** Installed CRDs for the operator/certificate endpoints (empty when RBAC-denied). */
export async function installedCrds(handle: ClusterHandle): Promise<KubeObject[]> {
  const acquired = handle.watchers.acquire('apiextensions.k8s.io', 'v1', 'customresourcedefinitions');
  try {
    return (await optionalItems(acquired.watcher)).items;
  } finally {
    acquired.release();
  }
}

export async function optionalItems(watcher: {
  ready(): Promise<void>;
  items(): KubeObject[];
  currentState(): string;
}): Promise<{ items: KubeObject[]; unavailable: boolean }> {
  try {
    await watcher.ready();
    return { items: watcher.items(), unavailable: watcher.currentState() === 'unavailable' };
  } catch (err) {
    if (isOptionalWatchUnavailable(err)) return { items: [], unavailable: true };
    throw err;
  }
}

function isOptionalWatchUnavailable(err: unknown): boolean {
  const code =
    (err as { code?: number })?.code ??
    (err as { statusCode?: number })?.statusCode ??
    ((err as { body?: { code?: unknown } })?.body?.code as number | undefined);
  return code === 403 || code === 404;
}
