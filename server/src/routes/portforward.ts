import type { FastifyInstance } from 'fastify';
import type { PortForwardRequest } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { sendError } from '../util/errors.js';

export function registerPortForwardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/portforwards', async () => ctx.portForwards.list());

  app.post<{ Params: { ctx: string }; Body: PortForwardRequest }>('/api/contexts/:ctx/portforwards', async (req, reply) => {
    try {
      return await ctx.portForwards.start(req.params.ctx, req.body);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/portforwards/:id', async (req, reply) => {
    try {
      ctx.portForwards.stop(req.params.id);
      return { ok: true };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
