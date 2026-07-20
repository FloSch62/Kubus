import type { FastifyInstance } from 'fastify';
import type { MetricsHistoryResponse, MetricsServerInstallRequest, MetricsSnapshot } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { computeNamespaceOverview } from '../kube/namespace-overview.js';
import { computeOverview } from '../kube/overview.js';
import { computePodResources } from '../kube/pod-resources.js';
import { installMetricsServer, metricsServerStatus, uninstallMetricsServer } from '../kube/metrics-server.js';
import { computeMetricsSummary } from '../kube/metrics-summary.js';
import { cpuToMilli, memToBytes } from '../kube/quantity.js';
import { sendError } from '../util/errors.js';

export function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/metrics/nodes', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const poller = handle.metricsPoller;
      const items = poller.nodeSnapshot();
      // Join allocatable capacity from the nodes watcher for utilization %.
      const nodesWatcher = handle.watchers.peek('', 'v1', 'nodes');
      const capacity = new Map<string, { cpu?: string; memory?: string }>();
      for (const node of nodesWatcher?.items() ?? []) {
        const alloc = (node.status as { allocatable?: { cpu?: string; memory?: string } })?.allocatable;
        if (alloc) capacity.set(node.metadata.name, alloc);
      }
      const snapshot: MetricsSnapshot = {
        available: poller.available,
        items: items.map((n) => {
          const alloc = capacity.get(n.name);
          return {
            ...n,
            cpuCapacityMilli: alloc?.cpu ? cpuToMilli(alloc.cpu) : undefined,
            memCapacityBytes: alloc?.memory ? memToBytes(alloc.memory) : undefined,
          };
        }),
      };
      return snapshot;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string } }>('/api/contexts/:ctx/metrics/pods', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const snapshot: MetricsSnapshot = {
        available: handle.metricsPoller.available,
        items: handle.metricsPoller.podSnapshot(req.query.namespace || undefined),
      };
      return snapshot;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { kind: 'pod' | 'node'; name: string; namespace?: string } }>('/api/contexts/:ctx/metrics/history', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const { kind, name, namespace } = req.query;
      const response: MetricsHistoryResponse = {
        available: handle.metricsPoller.available,
        series: handle.metricsPoller.history(kind, name, namespace || undefined),
      };
      return response;
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/metrics/summary', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return computeMetricsSummary(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/metrics-server', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await metricsServerStatus(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Body: MetricsServerInstallRequest | undefined }>('/api/contexts/:ctx/metrics-server/install', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await installMetricsServer(handle, { insecureTls: !!req.body?.insecureTls });
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.delete<{ Params: { ctx: string } }>('/api/contexts/:ctx/metrics-server', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await uninstallMetricsServer(handle, app.log);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/overview', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await computeOverview(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string } }>('/api/contexts/:ctx/overview/pod-resources', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await computePodResources(handle, req.query.namespace || undefined);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { namespaces?: string } }>('/api/contexts/:ctx/namespace-overview', async (req, reply) => {
    try {
      const namespaces = (req.query.namespaces ?? '')
        .split(',')
        .map((ns) => ns.trim())
        .filter(Boolean);
      if (namespaces.length === 0) {
        reply.code(400).send({ message: 'namespaces query parameter is required', reason: 'BadRequest', code: 400 });
        return reply;
      }
      const handle = ctx.clusters.get(req.params.ctx);
      return await computeNamespaceOverview(handle, namespaces);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
