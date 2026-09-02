import type { KubernetesObject } from '@kubernetes/client-node';
import type { HelmReleaseResource, HelmReleaseResourceState } from '@kubus/shared';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { manifestDocs } from './common.js';
import { READINESS_KINDS, workloadState, type LiveObject } from './readiness.js';
import { getLatestPayload } from './release-reader.js';

/** Parallel object reads per release; a large chart has a few dozen objects. */
const CONCURRENCY = 8;

interface ManifestItem {
  doc: KubernetesObject;
  hookEvents?: string[];
}

/**
 * Resolve the latest revision's manifest (and stored hooks) against the
 * cluster: does each object exist, and for workloads, is it ready? Order
 * follows the manifest, which is Helm's install order.
 */
export async function listReleaseResources(handle: ClusterHandle, namespace: string, name: string): Promise<HelmReleaseResource[]> {
  const payload = await getLatestPayload(handle, namespace, name);
  const items: ManifestItem[] = manifestDocs(payload.manifest, namespace).map((doc) => ({ doc }));
  for (const hook of payload.hooks ?? []) {
    for (const doc of manifestDocs(hook.manifest, namespace)) items.push({ doc, hookEvents: hook.events ?? [] });
  }
  const served = await handle.discovery.getResources();
  // Pods and Deployments are pinned cluster-wide watchers on every connected
  // cluster: their live caches answer without a round trip, and a live cache
  // that lacks the object is as authoritative as a 404.
  const indexByGvr = new Map<string, Map<string, LiveObject> | undefined>();
  const liveIndex = (group: string, version: string, plural: string): Map<string, LiveObject> | undefined => {
    const key = `${group}/${version}/${plural}`;
    if (!indexByGvr.has(key)) {
      const watcher = handle.watchers.peek(group, version, plural);
      indexByGvr.set(
        key,
        watcher?.currentState() === 'live'
          ? new Map(watcher.items().map((object) => [`${object.metadata.namespace ?? ''}/${object.metadata.name}`, object as unknown as LiveObject]))
          : undefined,
      );
    }
    return indexByGvr.get(key);
  };

  return mapWithConcurrency(items, CONCURRENCY, async ({ doc, hookEvents }) => {
    const apiVersion = doc.apiVersion ?? 'v1';
    const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/') as [string, string]) : ['', apiVersion];
    const kind = doc.kind ?? '';
    const base = { kind, apiVersion, group, version, name: doc.metadata?.name ?? '', hookEvents };
    const info = served.find((r) => r.group === group && r.version === version && r.kind === kind);
    if (!info) {
      return { ...base, plural: '', namespaced: true, namespace: doc.metadata?.namespace, state: 'unknown', message: `${apiVersion} ${kind} is not served by this cluster` };
    }
    const resolved = { ...base, plural: info.plural, namespaced: info.namespaced, namespace: info.namespaced ? doc.metadata?.namespace : undefined };
    try {
      const index = liveIndex(group, version, info.plural);
      const live = index
        ? index.get(`${resolved.namespace ?? ''}/${base.name}`)
        : await handle.raw.json<LiveObject>(resourcePath(group, version, info.plural, { namespace: resolved.namespace, name: base.name }));
      if (!live) throw Object.assign(new Error('not found'), { code: 404 });
      const meta = { uid: live.metadata?.uid, createdAt: live.metadata?.creationTimestamp };
      if (!READINESS_KINDS.has(kind)) return { ...resolved, ...meta, state: 'present' };
      const readiness = workloadState(kind, live);
      const state: HelmReleaseResourceState = readiness.failed ? 'failed' : readiness.ready ? 'ready' : 'progressing';
      return { ...resolved, ...meta, state, message: readiness.message };
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404) {
        return {
          ...resolved,
          state: 'missing',
          message: hookEvents ? 'Hook object is not present; its delete policy may have removed it after running.' : 'Not found in the cluster.',
        };
      }
      return { ...resolved, state: 'unknown', message: err instanceof Error ? err.message : String(err) };
    }
  });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
