import { setTimeout as delay } from 'node:timers/promises';
import type { KubeObject, RolloutRestartRequest, SetImageRequest } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { HttpProblem } from '../util/errors.js';

const KIND_TO_PLURAL: Record<RolloutRestartRequest['kind'], string> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  ReplicaSet: 'replicasets',
};

export async function scaleResource(handle: ClusterHandle, group: string, version: string, plural: string, namespace: string, name: string, replicas: number): Promise<void> {
  const path = resourcePath(group, version, plural, { namespace, name, subresource: 'scale' });
  await handle.raw.json(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { replicas } }),
  });
}

export async function rolloutRestart(handle: ClusterHandle, kind: RolloutRestartRequest['kind'], namespace: string, name: string): Promise<void> {
  if (kind === 'ReplicaSet') {
    await restartReplicaSet(handle, namespace, name);
    return;
  }
  const path = resourcePath('apps', 'v1', KIND_TO_PLURAL[kind], { namespace, name });
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
        },
      },
    },
  };
  await handle.raw.json(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/strategic-merge-patch+json' },
    body: JSON.stringify(patch),
  });
}

/**
 * ReplicaSets have no rollout machinery — the controller only reconciles
 * replica count, so a pod-template annotation patch does nothing. Restart
 * means deleting the pods it owns and letting it recreate them.
 */
async function restartReplicaSet(handle: ClusterHandle, namespace: string, name: string): Promise<void> {
  const rs = await handle.raw.json<KubeObject>(resourcePath('apps', 'v1', 'replicasets', { namespace, name }));
  const rsUid = rs.metadata.uid;
  const matchLabels = (rs.spec as { selector?: { matchLabels?: Record<string, string> } })?.selector?.matchLabels ?? {};
  const query = new URLSearchParams();
  const selector = Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  if (selector) query.set('labelSelector', selector);
  const pods = await handle.raw.json<{ items: KubeObject[] }>(resourcePath('', 'v1', 'pods', { namespace, query }));
  const owned = pods.items.filter((p) => (p.metadata.ownerReferences ?? []).some((o) => o.uid === rsUid && o.controller));
  const results = await Promise.allSettled(owned.map((pod) => handle.raw.json(resourcePath('', 'v1', 'pods', { namespace, name: pod.metadata.name }), { method: 'DELETE' })));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

export async function setCronJobSuspend(handle: ClusterHandle, namespace: string, name: string, suspend: boolean): Promise<void> {
  await handle.raw.json(resourcePath('batch', 'v1', 'cronjobs', { namespace, name }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { suspend } }),
  });
}

export async function setImage(handle: ClusterHandle, req: SetImageRequest): Promise<void> {
  if (!req.image || /\s/.test(req.image)) {
    throw new HttpProblem(422, 'image must be a non-empty reference without whitespace');
  }
  const listKey = req.initContainer ? 'initContainers' : 'containers';
  // Strategic merge patch merges container lists by name, so this updates
  // exactly the one container.
  const patch = { spec: { template: { spec: { [listKey]: [{ name: req.container, image: req.image }] } } } };
  await handle.raw.json(resourcePath('apps', 'v1', KIND_TO_PLURAL[req.kind], { namespace: req.namespace, name: req.name }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/strategic-merge-patch+json' },
    body: JSON.stringify(patch),
  });
}

export async function setCordon(handle: ClusterHandle, node: string, unschedulable: boolean): Promise<void> {
  await handle.raw.json(resourcePath('', 'v1', 'nodes', { name: node }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { unschedulable } }),
  });
}

/**
 * Clone a (typically finished) Job and submit it under a new name, stripping
 * the runtime fields the Job controller stamps onto it. Jobs with
 * spec.manualSelector keep their selector and labels — the user owns those.
 */
export async function rerunJob(handle: ClusterHandle, namespace: string, name: string): Promise<{ jobName: string }> {
  const src = await handle.batch.readNamespacedJob({ name, namespace });
  if (!src.spec) throw new HttpProblem(422, 'job has no spec');
  const jobName = `${name}-rerun-${Math.floor(Date.now() / 1000)}`.slice(0, 63);
  const spec = JSON.parse(JSON.stringify(src.spec)) as typeof src.spec;
  const labels = { ...src.metadata?.labels };
  const annotations = { ...src.metadata?.annotations };
  delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
  delete annotations['batch.kubernetes.io/job-tracking'];
  if (!spec.manualSelector) {
    delete spec.selector;
    const controllerLabels = ['controller-uid', 'batch.kubernetes.io/controller-uid', 'job-name', 'batch.kubernetes.io/job-name'];
    for (const key of controllerLabels) {
      delete labels[key];
      if (spec.template.metadata?.labels) delete spec.template.metadata.labels[key];
    }
  }
  await handle.batch.createNamespacedJob({
    namespace,
    body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
        labels: Object.keys(labels).length ? labels : undefined,
        annotations: { ...annotations, 'kubus.io/rerun-of': name },
      },
      spec,
    },
  });
  return { jobName };
}

export interface DrainProgress {
  evicted: number;
  total: number;
  current?: string;
  done?: boolean;
  error?: string;
}

/**
 * Cordon a node and evict all non-DaemonSet, non-mirror pods via the
 * Eviction API. PDB-blocked evictions (429) are retried for up to ~2 min
 * per pod. Reports progress through the callback; resolves when done.
 */
export async function drainNode(handle: ClusterHandle, node: string, opts: { gracePeriodSeconds?: number; force?: boolean }, onProgress: (p: DrainProgress) => void): Promise<void> {
  await setCordon(handle, node, true);
  const podList = await handle.core.listPodForAllNamespaces({
    fieldSelector: `spec.nodeName=${node}`,
  });
  const targets = podList.items.filter((pod) => {
    const owners = pod.metadata?.ownerReferences ?? [];
    if (owners.some((o) => o.kind === 'DaemonSet' && o.controller)) return false;
    if (pod.metadata?.annotations?.['kubernetes.io/config.mirror']) return false;
    if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') return false;
    return true;
  });

  const total = targets.length;
  let evicted = 0;
  onProgress({ evicted, total });

  for (const pod of targets) {
    const ns = pod.metadata!.namespace!;
    const podName = pod.metadata!.name!;
    onProgress({ evicted, total, current: `${ns}/${podName}` });
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await handle.raw.json(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}/eviction`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apiVersion: 'policy/v1',
            kind: 'Eviction',
            metadata: { name: podName, namespace: ns },
            deleteOptions: opts.gracePeriodSeconds !== undefined ? { gracePeriodSeconds: opts.gracePeriodSeconds } : undefined,
          }),
        });
        evicted++;
        onProgress({ evicted, total });
        break;
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 404) {
          // already gone
          evicted++;
          onProgress({ evicted, total });
          break;
        }
        if (code === 429 && Date.now() < deadline) {
          // blocked by PodDisruptionBudget — wait and retry
          await delay(5000);
          continue;
        }
        throw new HttpProblem(code && code >= 400 && code < 600 ? code : 500, `failed to evict ${ns}/${podName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  onProgress({ evicted, total, done: true });
}

/** Resolve a pod's containers (for log/exec container pickers). */
export function podContainers(pod: KubeObject): string[] {
  const spec = pod.spec as { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> } | undefined;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c) => c.name);
}
