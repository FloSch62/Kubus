import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { runAudit } from '../kube/audit.js';
import { sendError } from '../util/errors.js';

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/audit', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await runAudit(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
