import type { FastifyInstance } from 'fastify';
import type {
  HelmActionResult,
  HelmChartDetail,
  HelmChartSourceRef,
  HelmInstallRequest,
  HelmOperationStarted,
  HelmUpdateCheck,
  HelmUpgradeRequest,
} from '@kubus/shared';
import type { AppContext } from '../app.js';
import { inspectChart } from '../helm/engine.js';
import { installRelease } from '../helm/install.js';
import { getHistory, getRelease, getRevisionDetail, listReleaseRecords, listReleases, revOf } from '../helm/release-reader.js';
import {
  addRepo,
  checkChartUpdates,
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
  compareVersionsDesc,
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

function timeoutSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 10 || value > 1_800) {
    throw new HttpProblem(422, 'timeoutSeconds must be an integer between 10 and 1800');
  }
  return value;
}

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
    sources: inspected.metadata.sources,
    values: inspected.values,
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
  app.get('/api/helm/operations', async () => ctx.helmOperations.list());

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

  app.post<{
    Params: { ctx: string; ns: string; name: string };
    Body: { revision?: number; skipHooks?: boolean; wait?: boolean; timeoutSeconds?: number };
  }>(
    '/api/contexts/:ctx/helm/releases/:ns/:name/rollback',
    async (req, reply) => {
      try {
        const handle = ctx.clusters.get(req.params.ctx);
        const revision = req.body?.revision;
        if (!revision || !Number.isInteger(revision) || revision < 1) throw new HttpProblem(422, 'revision must be a positive integer');
        const timeout = timeoutSeconds(req.body?.timeoutSeconds);
        // Fail in-request for a missing release/revision — a 202 whose
        // operation can only ever fail is not an accepted rollback.
        const records = await listReleaseRecords(handle, req.params.ns, req.params.name);
        if (!records.length) throw new HttpProblem(404, `helm release "${req.params.ns}/${req.params.name}" not found`);
        if (!records.some((record) => revOf(record) === revision)) {
          throw new HttpProblem(404, `revision ${revision} of helm release "${req.params.ns}/${req.params.name}" not found`);
        }
        const started = ctx.helmOperations.start(
          {
            kind: 'rollback',
            ctx: req.params.ctx,
            namespace: req.params.ns,
            releaseName: req.params.name,
            targetRevision: revision,
          },
          async (report) => {
            const result = await rollbackRelease(handle, req.params.ns, req.params.name, revision, app.log, {
              skipHooks: req.body?.skipHooks,
              wait: req.body?.wait,
              timeoutSeconds: timeout,
              report,
            });
            handle.crdTracker.checkNow();
            return result;
          },
        );
        return reply.code(202).send(started satisfies HelmOperationStarted);
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
        // Same per-release exclusion as background operations: an uninstall
        // racing an in-flight upgrade would delete records the upgrade then
        // recreates, leaving live resources with no release history at all.
        const result = await ctx.helmOperations.runExclusive(
          { ctx: req.params.ctx, namespace: req.params.ns, releaseName: req.params.name },
          'uninstall',
          () =>
            uninstallRelease(handle, req.params.ns, req.params.name, app.log, {
              skipHooks: req.query.skipHooks === 'true',
              deleteCrds: req.query.deleteCrds === 'true',
            }),
        );
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
        const timeout = timeoutSeconds(body.timeoutSeconds);
        if (body.dryRun) {
          const chartArchive = await resolveChartArchive(ctx, body.chart);
          return await upgradeRelease(
            handle,
            {
              namespace: req.params.ns,
              name: req.params.name,
              values: body.values ?? {},
              chartArchive,
              skipHooks: body.skipHooks,
              wait: body.wait,
              timeoutSeconds: timeout,
              dryRun: true,
            },
            app.log,
          );
        }

        const currentRelease = body.chart?.version ? await getRelease(handle, req.params.ns, req.params.name) : undefined;
        const operationKind =
          currentRelease && body.chart?.version && compareVersionsDesc(body.chart.version, currentRelease.chartVersion) > 0 ? 'downgrade' : 'upgrade';
        const started = ctx.helmOperations.start(
          {
            kind: operationKind,
            ctx: req.params.ctx,
            namespace: req.params.ns,
            releaseName: req.params.name,
            targetVersion: body.chart?.version,
          },
          async (report) => {
            report({
              phase: 'resolving-chart',
              message: body.chart ? 'Downloading the target chart' : 'Using the chart stored with the current release',
            });
            const chartArchive = await resolveChartArchive(ctx, body.chart);
            const result = await upgradeRelease(
              handle,
              {
                namespace: req.params.ns,
                name: req.params.name,
                values: body.values ?? {},
                chartArchive,
                skipHooks: body.skipHooks,
                wait: body.wait,
                timeoutSeconds: timeout,
                report,
              },
              app.log,
            );
            handle.crdTracker.checkNow();
            return result as HelmActionResult;
          },
        );
        return reply.code(202).send(started satisfies HelmOperationStarted);
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
      if (!body.chart) throw new HttpProblem(422, 'chart source is required');
      const timeout = timeoutSeconds(body.timeoutSeconds);
      if (body.dryRun) {
        const chartArchive = await resolveChartArchive(ctx, body.chart);
        if (!chartArchive) throw new HttpProblem(422, 'chart source is required');
        return await installRelease(
          handle,
          {
            namespace: body.namespace,
            name: body.name,
            values: body.values ?? {},
            chartArchive,
            createNamespace: body.createNamespace,
            skipHooks: body.skipHooks,
            wait: body.wait,
            timeoutSeconds: timeout,
            dryRun: true,
          },
          app.log,
        );
      }

      const started = ctx.helmOperations.start(
        {
          kind: 'install',
          ctx: req.params.ctx,
          namespace: body.namespace,
          releaseName: body.name,
          targetVersion: body.chart.version,
        },
        async (report) => {
          report({ phase: 'resolving-chart', message: 'Downloading the chart' });
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
              wait: body.wait,
              timeoutSeconds: timeout,
              report,
            },
            app.log,
          );
          handle.crdTracker.checkNow();
          return result as HelmActionResult;
        },
      );
      return reply.code(202).send(started satisfies HelmOperationStarted);
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

  /** Batched update hints for the releases list. */
  app.post<{ Body: { items?: HelmUpdateCheck[] } }>('/api/helm/updates', async (req, reply) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items)) throw new HttpProblem(422, 'items must be an array');
      if (items.length > 100) throw new HttpProblem(422, 'at most 100 releases can be checked at once');
      if (
        items.some(
          (item) =>
            !item ||
            typeof item.id !== 'string' ||
            typeof item.chart !== 'string' ||
            typeof item.currentVersion !== 'string' ||
            (item.currentAppVersion !== undefined && typeof item.currentAppVersion !== 'string') ||
            item.id.length > 500 ||
            item.chart.length > 200 ||
            item.currentVersion.length > 100 ||
            (item.currentAppVersion?.length ?? 0) > 100,
        )
      ) {
        throw new HttpProblem(422, 'each item needs valid id, chart and currentVersion strings');
      }
      return await checkChartUpdates(ctx.settings, items);
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

  /** Chart metadata from any source form, including direct OCI and .tgz refs. */
  app.post<{ Body: HelmChartSourceRef }>('/api/helm/charts/detail', async (req, reply) => {
    try {
      const ref = req.body;
      if (!ref || typeof ref !== 'object') throw new HttpProblem(422, 'chart source is required');
      // Resolve lazily: a cache hit must not re-download the archive.
      return await chartDetail(ctx, JSON.stringify(ref), async () => {
        const encoded = await resolveChartArchive(ctx, ref);
        if (!encoded) throw new HttpProblem(422, 'chart source is required');
        return Buffer.from(encoded, 'base64');
      });
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
