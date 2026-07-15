import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { installNetworkAgent, networkAgentStatus, uninstallNetworkAgent } from '../kube/network-agent.js';
import { computeNetworkSummary } from '../kube/network-summary.js';
import { sendError } from '../util/errors.js';

export function registerNetworkMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/network-metrics/summary', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return computeNetworkSummary(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/network-agent', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await networkAgentStatus(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string } }>('/api/contexts/:ctx/network-agent/install', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await installNetworkAgent(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.delete<{ Params: { ctx: string } }>('/api/contexts/:ctx/network-agent', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await uninstallNetworkAgent(handle, app.log);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
