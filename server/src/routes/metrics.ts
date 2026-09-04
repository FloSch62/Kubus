import type { FastifyInstance } from 'fastify';
import type { MetricsHistoryResponse, MetricsServerInstallRequest, MetricsSnapshot, OverviewCertificates } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { apiServerCertNotAfter, collectCertificates } from '../kube/cert-expiry.js';
import { computeNamespaceOverview } from '../kube/namespace-overview.js';
import { computeOperatorRollups } from '../kube/operator-rollups.js';
import { computeOverview, installedCrds } from '../kube/overview.js';
import { computeClusterSignals } from '../kube/signals.js';
import { computePodResources } from '../kube/pod-resources.js';
import { installMetricsServer, metricsServerStatus, uninstallMetricsServer } from '../kube/metrics-server.js';
import { computeMetricsSummary } from '../kube/metrics-summary.js';
import { cpuToMilli, memToBytes } from '../kube/quantity.js';
import { sendError } from '../util/errors.js';

/** Optional `?namespaces=a,b` scope shared by the operator/certificate endpoints. */
function parseNamespaceScope(raw: string | undefined): ReadonlySet<string> | undefined {
  const namespaces = (raw ?? '')
    .split(',')
    .map((ns) => ns.trim())
    .filter(Boolean);
  return namespaces.length > 0 ? new Set(namespaces) : undefined;
}

export function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/metrics/nodes', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const poller = handle.metricsPoller;
      const items = poller.nodeSnapshot();
      // Join allocatable resources per sampled node, while summing full capacity
      // independently so nodes without a metrics-server sample still count.
      const nodesWatcher = handle.watchers.peek('', 'v1', 'nodes');
      const allocatableByNode = new Map<string, { cpu?: string; memory?: string }>();
      let totalCpuCapacityMilli = 0;
      let totalMemCapacityBytes = 0;
      let hasCpuCapacity = false;
      let hasMemCapacity = false;
      for (const node of nodesWatcher?.items() ?? []) {
        const status = node.status as {
          capacity?: { cpu?: string; memory?: string };
          allocatable?: { cpu?: string; memory?: string };
        };
        if (status.allocatable) allocatableByNode.set(node.metadata.name, status.allocatable);
        if (status.capacity?.cpu) {
          totalCpuCapacityMilli += cpuToMilli(status.capacity.cpu);
          hasCpuCapacity = true;
        }
        if (status.capacity?.memory) {
          totalMemCapacityBytes += memToBytes(status.capacity.memory);
          hasMemCapacity = true;
        }
      }
      const snapshot: MetricsSnapshot = {
        available: poller.available,
        probed: poller.probed,
        totalCpuCapacityMilli: hasCpuCapacity ? totalCpuCapacityMilli : undefined,
        totalMemCapacityBytes: hasMemCapacity ? totalMemCapacityBytes : undefined,
        items: items.map((n) => {
          const allocatable = allocatableByNode.get(n.name);
          return {
            ...n,
            cpuCapacityMilli: allocatable?.cpu ? cpuToMilli(allocatable.cpu) : undefined,
            memCapacityBytes: allocatable?.memory ? memToBytes(allocatable.memory) : undefined,
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
        probed: handle.metricsPoller.probed,
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
        probed: handle.metricsPoller.probed,
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

  // Per-object warning events and restarts — the marker data for list rows and tabs.
  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/overview/signals', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await computeClusterSignals(handle);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  // Operator rollups and certificate expiry are split off the main overview
  // payload: both can involve slow warmups (operator CR lists; the all-secrets
  // watcher and an API-server TLS probe) and stream in behind the core stats.
  app.get<{ Params: { ctx: string }; Querystring: { namespaces?: string } }>('/api/contexts/:ctx/overview/operators', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      return await computeOperatorRollups(handle, await installedCrds(handle), parseNamespaceScope(req.query.namespaces));
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { namespaces?: string } }>('/api/contexts/:ctx/overview/certificates', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const scope = parseNamespaceScope(req.query.namespaces);
      const [certificates, apiServerNotAfter] = await Promise.all([
        installedCrds(handle).then((crds) => collectCertificates(handle, crds, scope)),
        scope ? undefined : apiServerCertNotAfter(handle),
      ]);
      const response: OverviewCertificates = { ...certificates, apiServerNotAfter };
      return response;
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
