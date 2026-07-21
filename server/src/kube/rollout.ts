import type { KubeObject, RolloutRevision } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resourcePath } from './raw-client.js';
import { HttpProblem } from '../util/errors.js';

type RolloutKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

const ROLLOUT_PLURALS: Record<RolloutKind, string> = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' };

interface WorkloadSpec {
  selector?: { matchLabels?: Record<string, string> };
  template?: { spec?: { containers?: Array<{ image?: string }>; initContainers?: Array<{ image?: string }> } };
  paused?: boolean;
}

async function getWorkload(handle: ClusterHandle, kind: RolloutKind, namespace: string, name: string): Promise<KubeObject> {
  return handle.raw.json<KubeObject>(resourcePath('apps', 'v1', ROLLOUT_PLURALS[kind], { namespace, name }));
}

/** List children (ReplicaSets / ControllerRevisions) owned by the workload. */
async function listOwnedChildren(handle: ClusterHandle, workload: KubeObject, namespace: string, childPlural: string): Promise<KubeObject[]> {
  const matchLabels = (workload.spec as WorkloadSpec)?.selector?.matchLabels ?? {};
  const query = new URLSearchParams();
  const selector = Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  if (selector) query.set('labelSelector', selector);
  const list = await handle.raw.json<{ items: KubeObject[] }>(resourcePath('apps', 'v1', childPlural, { namespace, query }));
  const uid = workload.metadata.uid;
  return list.items.filter((c) => (c.metadata.ownerReferences ?? []).some((o) => o.uid === uid && o.controller));
}

function templateImages(template: WorkloadSpec['template']): string[] {
  const spec = template?.spec;
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map((c) => c.image ?? '').filter(Boolean);
}

export async function getRolloutHistory(handle: ClusterHandle, kind: RolloutKind, namespace: string, name: string): Promise<RolloutRevision[]> {
  const workload = await getWorkload(handle, kind, namespace, name);
  if (kind === 'Deployment') {
    const currentRev = Number(workload.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
    const children = await listOwnedChildren(handle, workload, namespace, 'replicasets');
    return children
      .map((rs): RolloutRevision => {
        const revision = Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
        return {
          revision,
          name: rs.metadata.name,
          createdAt: rs.metadata.creationTimestamp,
          images: templateImages((rs.spec as WorkloadSpec)?.template),
          changeCause: rs.metadata.annotations?.['kubernetes.io/change-cause'],
          current: revision === currentRev,
          replicas: (rs.status as { replicas?: number })?.replicas,
        };
      })
      .sort((a, b) => b.revision - a.revision);
  }
  // StatefulSet / DaemonSet: ControllerRevisions carry the revision as a
  // first-class field and the pod template inside .data (a strategic-merge
  // patch). StatefulSets name their live revision in status.updateRevision;
  // DaemonSets don't, so there the newest revision is the current one.
  const updateRevisionName = kind === 'StatefulSet' ? (workload.status as { updateRevision?: string })?.updateRevision : undefined;
  const children = await listOwnedChildren(handle, workload, namespace, 'controllerrevisions');
  const maxRevision = children.reduce((max, cr) => Math.max(max, Number((cr as { revision?: number }).revision ?? 0)), 0);
  return children
    .map((cr): RolloutRevision => {
      const data = (cr as { data?: { spec?: { template?: WorkloadSpec['template'] } } }).data;
      const revision = Number((cr as { revision?: number }).revision ?? 0);
      return {
        revision,
        name: cr.metadata.name,
        createdAt: cr.metadata.creationTimestamp,
        images: templateImages(data?.spec?.template as WorkloadSpec['template']),
        changeCause: cr.metadata.annotations?.['kubernetes.io/change-cause'],
        current: updateRevisionName ? cr.metadata.name === updateRevisionName : revision === maxRevision,
        replicas: undefined,
      };
    })
    .sort((a, b) => b.revision - a.revision);
}

/** Equivalent of `kubectl rollout undo [--to-revision]`. */
export async function rolloutUndo(handle: ClusterHandle, kind: RolloutKind, namespace: string, name: string, toRevision?: number): Promise<void> {
  const history = await getRolloutHistory(handle, kind, namespace, name);
  if (history.length === 0) throw new HttpProblem(404, 'no rollout history found');
  let target: RolloutRevision | undefined;
  if (toRevision !== undefined) {
    target = history.find((r) => r.revision === toRevision);
    if (!target) throw new HttpProblem(404, `revision ${toRevision} not found — it may have been pruned by revisionHistoryLimit`);
    if (target.current) throw new HttpProblem(422, `revision ${toRevision} is already the current revision`);
  } else {
    target = history.find((r) => !r.current);
    if (!target) throw new HttpProblem(422, 'no previous revision to roll back to');
  }

  if (kind === 'Deployment') {
    const rs = await handle.raw.json<KubeObject>(resourcePath('apps', 'v1', 'replicasets', { namespace, name: target.name }));
    const template = JSON.parse(JSON.stringify((rs.spec as WorkloadSpec).template ?? {})) as {
      metadata?: { labels?: Record<string, string> };
    };
    // kubectl strips the hash label before re-applying the old template;
    // leaving it would corrupt the Deployment's selector/labels contract.
    if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
    await handle.raw.json(resourcePath('apps', 'v1', 'deployments', { namespace, name }), {
      method: 'PATCH',
      headers: { 'content-type': 'application/strategic-merge-patch+json' },
      body: JSON.stringify({ spec: { template } }),
    });
    return;
  }

  // StatefulSet / DaemonSet: the ControllerRevision's .data is itself the patch to apply.
  const cr = await handle.raw.json<KubeObject & { data?: unknown }>(resourcePath('apps', 'v1', 'controllerrevisions', { namespace, name: target.name }));
  if (!cr.data) throw new HttpProblem(422, 'controller revision has no data');
  await handle.raw.json(resourcePath('apps', 'v1', ROLLOUT_PLURALS[kind], { namespace, name }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/strategic-merge-patch+json' },
    body: JSON.stringify(cr.data),
  });
}

/** Pause/resume a Deployment rollout (Deployments only). */
export async function setRolloutPaused(handle: ClusterHandle, namespace: string, name: string, paused: boolean): Promise<void> {
  await handle.raw.json(resourcePath('apps', 'v1', 'deployments', { namespace, name }), {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { paused: paused || null } }),
  });
}
