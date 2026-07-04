import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { getHistory, getRelease, getRevisionDetail, listReleases } from '../helm/release-reader.js';
import { rollbackRelease } from '../helm/rollback.js';
import { uninstallRelease } from '../helm/uninstall.js';
import { HttpProblem, sendError } from '../util/errors.js';

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

  app.post<{ Params: { ctx: string; ns: string; name: string }; Body: { revision?: number } }>(
    '/api/contexts/:ctx/helm/releases/:ns/:name/rollback',
    async (req, reply) => {
      try {
        const handle = ctx.clusters.get(req.params.ctx);
        const revision = req.body?.revision;
        if (!revision || !Number.isInteger(revision) || revision < 1) throw new HttpProblem(422, 'revision must be a positive integer');
        return await rollbackRelease(handle, req.params.ns, req.params.name, revision, app.log);
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );

  app.delete<{ Params: { ctx: string; ns: string; name: string } }>('/api/contexts/:ctx/helm/releases/:ns/:name', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await uninstallRelease(handle, req.params.ns, req.params.name, app.log);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
