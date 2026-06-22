import type { FastifyInstance } from 'fastify';
import { BUILTIN_NAV_GROUPS, groupToPath, type KubeObject, type ResourceKindInfo, type ResourceRef, type SearchResult } from '@kubus/shared';
import type { AppContext } from '../app.js';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { sendError } from '../util/errors.js';

const PAGES: Array<{ title: string; path: string; subtitle: string }> = [
  { title: 'Overview', path: '/', subtitle: 'Cluster health dashboard' },
  { title: 'Topology', path: '/topology', subtitle: 'Resource relationship graph' },
  { title: 'Helm Releases', path: '/helm', subtitle: 'Installed Helm releases' },
  { title: 'Port Forwards', path: '/forwards', subtitle: 'Active local forwards' },
  { title: 'Diff', path: '/diff', subtitle: 'Compare resources' },
];

const RESOURCE_SEARCH_KINDS = BUILTIN_NAV_GROUPS.flatMap((g) => g.kinds)
  .filter((k) => ['Pod', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Ingress', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Node', 'Namespace'].includes(k.kind));

function scoreText(q: string, ...parts: Array<string | undefined>): number {
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  if (!q) return 1;
  if (hay === q) return 100;
  if (hay.startsWith(q)) return 80;
  if (hay.includes(q)) return 40;
  return 0;
}

function refFor(ctx: string, kind: ResourceKindInfo, obj: KubeObject): ResourceRef {
  return {
    ctx,
    group: kind.group,
    version: kind.version,
    plural: kind.plural,
    kind: kind.kind,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    uid: obj.metadata.uid,
  };
}

async function listKind(handle: ClusterHandle, kind: ResourceKindInfo): Promise<KubeObject[]> {
  const query = new URLSearchParams({ limit: '500' });
  const list = await handle.raw.json<{ items?: KubeObject[] }>(resourcePath(kind.group, kind.version, kind.plural, { query }));
  return list.items ?? [];
}

async function searchContext(handle: ClusterHandle, query: string, limit: number): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  const out: SearchResult[] = [];

  for (const page of PAGES) {
    const score = scoreText(q, page.title, page.subtitle);
    if (score) out.push({ id: `page:${page.path}`, kind: 'page', title: page.title, subtitle: page.subtitle, score, path: page.path });
  }

  const resources = await handle.discovery.getResources();
  for (const kind of resources) {
    const score = scoreText(q, kind.kind, kind.plural, kind.group, ...(kind.shortNames ?? []));
    if (!score) continue;
    out.push({
      id: `kind:${kind.group}/${kind.version}/${kind.plural}`,
      kind: 'kind',
      title: kind.kind,
      subtitle: kind.group ? `${kind.group}/${kind.version}` : kind.version,
      score,
      path: `/r/${groupToPath(kind.group)}/${kind.version}/${kind.plural}`,
    });
  }

  const byGvr = new Map(resources.map((r) => [`${r.group}/${r.version}/${r.plural}`, r]));
  await Promise.all(
    RESOURCE_SEARCH_KINDS.map(async (base) => {
      const kind = byGvr.get(`${base.group}/${base.version}/${base.plural}`);
      if (!kind?.verbs.includes('list')) return;
      const items = await listKind(handle, kind).catch(() => []);
      for (const obj of items) {
        const labels = Object.entries(obj.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
        const score = scoreText(q, obj.metadata.name, obj.metadata.namespace, kind.kind, labels);
        if (!score) continue;
        const ref = refFor(handle.contextName, kind, obj);
        out.push({
          id: `resource:${ref.ctx}:${ref.group}/${ref.version}/${ref.plural}:${ref.namespace ?? ''}:${ref.name}`,
          kind: 'resource',
          title: `${kind.kind}/${obj.metadata.name}`,
          subtitle: `${handle.contextName}${obj.metadata.namespace ? ` · ${obj.metadata.namespace}` : ''}`,
          score: score + 5,
          ref,
          path: `/r/${groupToPath(kind.group)}/${kind.version}/${kind.plural}`,
        });
      }
    }),
  );

  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string }; Querystring: { q?: string; limit?: string } }>('/api/contexts/:ctx/search', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 30)));
      return await searchContext(handle, req.query.q ?? '', limit);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
