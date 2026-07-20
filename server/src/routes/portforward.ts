import type { FastifyInstance } from 'fastify';
import type { LocalPortCheckResponse, PortForwardPreflightResponse, PortForwardRequest } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';

export function registerPortForwardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/portforwards', async () => ctx.portForwards.list());

  app.get<{ Querystring: { port?: string } }>('/api/portforwards/port-check', async (req, reply) => {
    try {
      const port = Number(req.query.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpProblem(422, 'port must be an integer between 1 and 65535');
      const response: LocalPortCheckResponse = { port, available: await ctx.portForwards.isLocalPortFree(port) };
      return response;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string } }>('/api/contexts/:ctx/portforwards/preflight', async (req, reply) => {
    try {
      if (!req.query.namespace) throw new HttpProblem(422, 'namespace is required');
      const response: PortForwardPreflightResponse = await ctx.portForwards.preflight(req.params.ctx, req.query.namespace);
      return response;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: PortForwardRequest }>('/api/contexts/:ctx/portforwards', async (req, reply) => {
    try {
      return await ctx.portForwards.start(req.params.ctx, req.body);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.delete('/api/portforwards', async () => {
    ctx.portForwards.stopAll();
    return { ok: true };
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
