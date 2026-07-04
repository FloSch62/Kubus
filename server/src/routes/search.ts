import type { FastifyInstance } from 'fastify';
import { groupToPath, type ResourceKindInfo, type ResourceRef, type SearchResult } from '@kubus/shared';
import type { AppContext } from '../app.js';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import type { IndexedResourceSearchEntry } from '../kube/search-index.js';
import { sendError } from '../util/errors.js';

const PAGES: Array<{ title: string; path: string; subtitle: string }> = [
  { title: 'Overview', path: '/', subtitle: 'Cluster health dashboard' },
  { title: 'Topology', path: '/topology', subtitle: 'Resource relationship graph' },
  { title: 'Security Audit', path: '/audit', subtitle: 'Built-in security checks' },
  { title: 'Helm Releases', path: '/helm', subtitle: 'Installed Helm releases' },
  { title: 'Port Forwards', path: '/forwards', subtitle: 'Active local forwards' },
  { title: 'Diff', path: '/diff', subtitle: 'Compare resources' },
];

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSearchText(value: string): string {
  return value.replace(/\s+/g, '');
}

function scoreOrderedTokens(queryTokens: string[], hayTokens: string[]): number {
  let nextIndex = 0;
  let score = 0;

  for (const queryToken of queryTokens) {
    let matched = false;

    for (let i = nextIndex; i < hayTokens.length; i += 1) {
      const hayToken = hayTokens[i]!;
      if (hayToken === queryToken) {
        score += 8;
        matched = true;
      } else if (hayToken.startsWith(queryToken)) {
        score += 6;
        matched = true;
      } else if (queryToken.length > 2 && hayToken.includes(queryToken)) {
        score += 4;
        matched = true;
      }

      if (matched) {
        nextIndex = i + 1;
        break;
      }
    }

    if (!matched) return 0;
  }

  return Math.min(35, 20 + score);
}

function scoreText(query: string, ...parts: Array<string | undefined>): number {
  const rawQuery = query.trim().toLowerCase();
  const q = normalizeSearchText(rawQuery);
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  const normalizedHay = normalizeSearchText(hay);
  if (!q) return 1;
  if (!normalizedHay) return 0;
  if (hay === rawQuery || normalizedHay === q) return 100;
  if (hay.startsWith(rawQuery) || normalizedHay.startsWith(q)) return 80;
  if (hay.includes(rawQuery) || normalizedHay.includes(q)) return 40;

  const compactQuery = compactSearchText(q);
  if (compactQuery.length > 2 && compactSearchText(normalizedHay).includes(compactQuery)) return 35;

  return scoreOrderedTokens(q.split(' '), normalizedHay.split(' '));
}

function refFor(ctx: string, entry: IndexedResourceSearchEntry): ResourceRef {
  return {
    ctx,
    group: entry.kind.group,
    version: entry.kind.version,
    plural: entry.kind.plural,
    kind: entry.kind.kind,
    name: entry.name,
    namespace: entry.namespace,
    uid: entry.uid,
  };
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
      // Kinds outrank resource hits of equal match quality: there are few of
      // them and they are usually what a short query like "art" is after.
      score: score + 20,
      path: `/r/${groupToPath(kind.group)}/${kind.version}/${kind.plural}`,
    });
  }

  for (const entry of await handle.searchIndex.entries()) {
    const nameScore = scoreText(q, entry.name);
    const score = Math.max(
      nameScore ? nameScore + 10 : 0,
      scoreText(q, entry.name, entry.namespace, entry.kind.kind, entry.kind.plural, entry.kind.group, entry.labelsText),
    );
    if (!score) continue;
    const ref = refFor(handle.contextName, entry);
    out.push({
      id: `resource:${ref.ctx}:${ref.group}/${ref.version}/${ref.plural}:${ref.namespace ?? ''}:${ref.name}`,
      kind: 'resource',
      title: `${entry.kind.kind}/${entry.name}`,
      subtitle: `${handle.contextName}${entry.namespace ? ` · ${entry.namespace}` : ''}`,
      score: score + 5,
      ref,
      path: `/r/${groupToPath(entry.kind.group)}/${entry.kind.version}/${entry.kind.plural}`,
    });
  }

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
