import type { FastifyInstance } from 'fastify';
import type { HelmChartDetail, HelmChartSourceRef, HelmInstallRequest, HelmUpgradeRequest } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { inspectChart } from '../helm/engine.js';
import { installRelease } from '../helm/install.js';
import { getHistory, getRelease, getRevisionDetail, listReleases } from '../helm/release-reader.js';
import {
  addRepo,
  fetchChartArchive,
  fetchChartArchiveByRepoUrl,
  fetchChartByUrl,
  findChartInRepos,
  getRepo,
  hubChartVersions,
  listChartVersions,
  listCharts,
  listOciTags,
  listRepos,
  pullOciChart,
  removeRepo,
  searchHub,
} from '../helm/repo.js';
import { rollbackRelease } from '../helm/rollback.js';
import { uninstallRelease } from '../helm/uninstall.js';
import { upgradeRelease } from '../helm/upgrade.js';
import { HttpProblem, sendError } from '../util/errors.js';

async function resolveChartArchive(ctx: AppContext, ref: HelmChartSourceRef | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  if (ref.ociRef) {
    if (!ref.version) throw new HttpProblem(422, 'OCI chart refs need an explicit version');
    return (await pullOciChart(ref.ociRef, ref.version)).toString('base64');
  }
  if (ref.url) return (await fetchChartByUrl(ref.url)).toString('base64');
  if (ref.repoUrl && ref.chart && ref.version) {
    return (await fetchChartArchiveByRepoUrl(ref.repoUrl, ref.chart, ref.version)).toString('base64');
  }
  if (ref.repo && ref.chart && ref.version) {
    return (await fetchChartArchive(getRepo(ctx.settings, ref.repo), ref.chart, ref.version)).toString('base64');
  }
  throw new HttpProblem(422, 'chart source must be repo+chart+version, a repository URL, an oci:// ref, or a .tgz URL');
}

// Chart detail requires downloading + unpacking the archive; keep a small cache.
const detailCache = new Map<string, HelmChartDetail>();
const DETAIL_CACHE_MAX = 30;

async function chartDetail(ctx: AppContext, key: string, archive: () => Promise<Buffer>): Promise<HelmChartDetail> {
  const cached = detailCache.get(key);
  if (cached) return cached;
  const buf = await archive();
  const inspected = await inspectChart(buf.toString('base64'));
  const detail: HelmChartDetail = {
    name: inspected.metadata.name,
    version: inspected.metadata.version,
    appVersion: inspected.metadata.appVersion,
    description: inspected.metadata.description,
    icon: inspected.metadata.icon,
    home: inspected.metadata.home,
    valuesYaml: inspected.valuesYaml,
    readme: inspected.readme,
    dependencies: inspected.metadata.dependencies?.map((d) => ({ name: d.name, version: d.version, repository: d.repository })),
  };
  if (detailCache.size >= DETAIL_CACHE_MAX) {
    const first = detailCache.keys().next().value;
    if (first) detailCache.delete(first);
  }
  detailCache.set(key, detail);
  return detail;
}

export function registerHelmRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string } }>('/api/contexts/:ctx/helm/releases', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await listReleases(handle, req.query.namespace || undefined);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string; ns: string; name: string } }>('/api/contexts/:ctx/helm/releases/:ns/:name', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await getRelease(handle, req.params.ns, req.params.name);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string; ns: string; name: string } }>('/api/contexts/:ctx/helm/releases/:ns/:name/history', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await getHistory(handle, req.params.ns, req.params.name);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string; ns: string; name: string; revision: string } }>(
    '/api/contexts/:ctx/helm/releases/:ns/:name/revisions/:revision',
    async (req, reply) => {
      try {
        const handle = ctx.clusters.get(req.params.ctx);
        const revision = Number(req.params.revision);
        if (!Number.isInteger(revision) || revision < 1) throw new HttpProblem(422, 'revision must be a positive integer');
        return await getRevisionDetail(handle, req.params.ns, req.params.name, revision);
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.post<{ Params: { ctx: string; ns: string; name: string }; Body: { revision?: number; skipHooks?: boolean } }>(
    '/api/contexts/:ctx/helm/releases/:ns/:name/rollback',
    async (req, reply) => {
      try {
        const handle = ctx.clusters.get(req.params.ctx);
        const revision = req.body?.revision;
        if (!revision || !Number.isInteger(revision) || revision < 1) throw new HttpProblem(422, 'revision must be a positive integer');
        const result = await rollbackRelease(handle, req.params.ns, req.params.name, revision, app.log, req.body?.skipHooks ?? false);
        handle.crdTracker.checkNow();
        return result;
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.delete<{ Params: { ctx: string; ns: string; name: string }; Querystring: { skipHooks?: string; deleteCrds?: string } }>(
    '/api/contexts/:ctx/helm/releases/:ns/:name',
    async (req, reply) => {
      try {
        const handle = ctx.clusters.get(req.params.ctx);
        const result = await uninstallRelease(handle, req.params.ns, req.params.name, app.log, {
          skipHooks: req.query.skipHooks === 'true',
          deleteCrds: req.query.deleteCrds === 'true',
        });
        handle.crdTracker.checkNow();
        return result;
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.post<{ Params: { ctx: string; ns: string; name: string }; Body: HelmUpgradeRequest }>(
    '/api/contexts/:ctx/helm/releases/:ns/:name/upgrade',
    async (req, reply) => {
      try {
        const handle = ctx.clusters.get(req.params.ctx);
        const body = req.body ?? ({} as HelmUpgradeRequest);
        const chartArchive = await resolveChartArchive(ctx, body.chart);
        const result = await upgradeRelease(
          handle,
          {
            namespace: req.params.ns,
            name: req.params.name,
            values: body.values ?? {},
            chartArchive,
            skipHooks: body.skipHooks,
            dryRun: body.dryRun,
          },
          app.log,
        );
        if (!body.dryRun) handle.crdTracker.checkNow();
        return result;
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.post<{ Params: { ctx: string }; Body: HelmInstallRequest }>('/api/contexts/:ctx/helm/install', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const body = req.body;
      if (!body?.name || !body.namespace) throw new HttpProblem(422, 'name and namespace are required');
      const chartArchive = await resolveChartArchive(ctx, body.chart);
      if (!chartArchive) throw new HttpProblem(422, 'chart source is required');
      const result = await installRelease(
        handle,
        {
          namespace: body.namespace,
          name: body.name,
          values: body.values ?? {},
          chartArchive,
          createNamespace: body.createNamespace,
          skipHooks: body.skipHooks,
          dryRun: body.dryRun,
        },
        app.log,
      );
      if (!body.dryRun) handle.crdTracker.checkNow();
      return result;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  // ---- Chart repositories (app-global, not per cluster) ----

  app.get('/api/helm/repos', async () => listRepos(ctx.settings));

  app.post<{ Body: { name?: string; url?: string } }>('/api/helm/repos', async (req, reply) => {
    try {
      const { name, url } = req.body ?? {};
      if (!name || !url) throw new HttpProblem(422, 'name and url are required');
      return await addRepo(ctx.settings, name, url);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.delete<{ Params: { name: string } }>('/api/helm/repos/:name', async (req, reply) => {
    try {
      removeRepo(ctx.settings, req.params.name);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { name: string } }>('/api/helm/repos/:name/charts', async (req, reply) => {
    try {
      return await listCharts(getRepo(ctx.settings, req.params.name));
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { name: string; chart: string } }>('/api/helm/repos/:name/charts/:chart/versions', async (req, reply) => {
    try {
      return await listChartVersions(getRepo(ctx.settings, req.params.name), req.params.chart);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { name: string; chart: string; version: string } }>(
    '/api/helm/repos/:name/charts/:chart/versions/:version/detail',
    async (req, reply) => {
      try {
        const repo = getRepo(ctx.settings, req.params.name);
        const key = `${repo.url}|${req.params.chart}|${req.params.version}`;
        return await chartDetail(ctx, key, () => fetchChartArchive(repo, req.params.chart, req.params.version));
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  /** Exact-name search across all configured repos (upgrade-source discovery). */
  app.get<{ Querystring: { name?: string } }>('/api/helm/charts/find', async (req, reply) => {
    try {
      if (!req.query.name) throw new HttpProblem(422, 'name query parameter is required');
      return await findChartInRepos(ctx.settings, req.query.name);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  // ---- Artifact Hub ----

  app.get<{ Querystring: { q?: string } }>('/api/helm/hub/search', async (req, reply) => {
    try {
      if (!req.query.q?.trim()) return [];
      return await searchHub(req.query.q.trim());
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Querystring: { repo?: string; chart?: string } }>('/api/helm/hub/versions', async (req, reply) => {
    try {
      const { repo, chart } = req.query;
      if (!repo || !chart) throw new HttpProblem(422, 'repo and chart query parameters are required');
      return await hubChartVersions(repo, chart);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  /** Chart metadata + default values by repository URL (Artifact Hub discoveries). */
  app.get<{ Querystring: { repoUrl?: string; chart?: string; version?: string } }>('/api/helm/charts/detail', async (req, reply) => {
    try {
      const { repoUrl, chart, version } = req.query;
      if (!repoUrl || !chart || !version) throw new HttpProblem(422, 'repoUrl, chart and version query parameters are required');
      return await chartDetail(ctx, `${repoUrl}|${chart}|${version}`, () => fetchChartArchiveByRepoUrl(repoUrl, chart, version));
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  // ---- Direct OCI refs ----

  app.get<{ Querystring: { ref?: string } }>('/api/helm/oci/tags', async (req, reply) => {
    try {
      if (!req.query.ref) throw new HttpProblem(422, 'ref query parameter is required');
      return await listOciTags(req.query.ref);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Querystring: { ref?: string; version?: string } }>('/api/helm/oci/detail', async (req, reply) => {
    try {
      const { ref, version } = req.query;
      if (!ref || !version) throw new HttpProblem(422, 'ref and version query parameters are required');
      return await chartDetail(ctx, `${ref}|${version}`, () => pullOciChart(ref, version));
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
