import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pluginCanRead, type KubeObject } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { PluginManager } from '../plugins/manager.js';
import { pluginInterfacesSchema, pluginResourceSchema } from '../plugins/manifest.js';
import { readPodInterfaces } from '../plugins/pod-interfaces.js';
import { resourcePath } from '../kube/raw-client.js';
import { maybeRedact } from '../kube/redact.js';
import { HttpProblem, sendError } from '../util/errors.js';

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};
export function registerPluginRoutes(app: FastifyInstance, ctx: AppContext, manager: PluginManager): void {
  let inspections = 0;
  // Bundled files must only be served through the CSP-protected asset endpoint.
  app.get('/plugin-bundles/*', async (_req, reply) => reply.code(404).send({ message: 'not found' }));
  app.get('/api/plugins', async () => manager.list());
  app.post('/api/plugins/install', async (req, reply) => {
    try {
      const input = z
        .object({ path: z.string().min(1).max(4096) })
        .strict()
        .parse(req.body);
      return manager.install(input.path);
    } catch (error) {
      sendError(reply, error instanceof z.ZodError ? new HttpProblem(400, 'A plugin directory path is required') : error);
      return reply;
    }
  });
  app.put<{ Params: { id: string } }>('/api/plugins/:id', async (req, reply) => {
    try {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      manager.setEnabled(req.params.id, enabled);
      return manager.list();
    } catch (error) {
      sendError(reply, error instanceof z.ZodError ? new HttpProblem(400, 'enabled must be a boolean') : error);
      return reply;
    }
  });
  app.delete<{ Params: { id: string } }>('/api/plugins/:id', async (req, reply) => {
    try {
      manager.remove(req.params.id);
      return manager.list();
    } catch (error) {
      sendError(reply, error);
      return reply;
    }
  });
  app.post<{ Params: { id: string } }>('/api/plugins/:id/resources', async (req, reply) => {
    try {
      const bundle = manager.get(req.params.id);
      const input = pluginResourceSchema.safeParse(req.body);
      if (!input.success) throw new HttpProblem(400, 'Invalid plugin resource request');
      const p = input.data;
      if (!pluginCanRead(bundle.manifest, p.group, p.plural)) throw new HttpProblem(403, 'Resource access was not declared by this plugin');
      const handle = ctx.clusters.get(p.ctx);
      const kind = await handle.discovery.find(p.group, p.version, p.plural);
      if (!kind) throw new HttpProblem(404, `${p.group || 'core'}/${p.version}/${p.plural} is not installed in this cluster`);
      if (kind.namespaced && p.namespaceScope?.length && (!p.namespace || !p.namespaceScope.includes(p.namespace))) {
        throw new HttpProblem(403, 'Resource is outside the selected namespaces');
      }
      if (p.name && kind.namespaced && !p.namespace) throw new HttpProblem(400, 'A namespace is required for this resource');
      if (p.namespace && !kind.namespaced) throw new HttpProblem(400, 'This resource is cluster scoped');
      const query = new URLSearchParams();
      if (!p.name) {
        query.set('limit', '500');
        if (p.continue) query.set('continue', p.continue);
        if (p.labelSelector) query.set('labelSelector', p.labelSelector);
      }
      const url = resourcePath(p.group, p.version, p.plural, { namespace: p.namespace, name: p.name, query });
      const clean = (obj: KubeObject) => {
        const next = maybeRedact(obj, p.group, p.plural);
        if (next.metadata) delete (next.metadata as unknown as Record<string, unknown>).managedFields;
        return next;
      };
      const result = p.name
        ? clean(await handle.raw.json<KubeObject>(url))
        : await handle.raw
            .json<{ items?: KubeObject[]; metadata?: { continue?: string } }>(url)
            .then((list) => ({ items: (list.items ?? []).map(clean), continue: list.metadata?.continue }));
      // Revoking a plugin also prevents an in-flight response from crossing the boundary.
      manager.get(req.params.id);
      return { data: result, kind };
    } catch (error) {
      sendError(reply, error);
      return reply;
    }
  });
  app.post<{ Params: { id: string } }>('/api/plugins/:id/interfaces', async (req, reply) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    reply.raw.on('close', cancel);
    let acquired = false;
    try {
      const bundle = manager.get(req.params.id);
      const input = pluginInterfacesSchema.safeParse(req.body);
      if (!input.success) throw new HttpProblem(400, 'Invalid Pod interface request');
      const p = input.data;
      if (!bundle.manifest.permissions.actions.includes('pod.interfaces') || !pluginCanRead(bundle.manifest, '', 'pods'))
        throw new HttpProblem(403, 'Pod interface inspection was not declared by this plugin');
      if (p.namespaceScope?.length && !p.namespaceScope.includes(p.namespace))
        throw new HttpProblem(403, 'Pod is outside the selected namespaces');
      if (inspections >= 8) throw new HttpProblem(429, 'Too many interface inspections; retry shortly');
      inspections++;
      acquired = true;
      const handle = ctx.clusters.get(p.ctx);
      const pod = await handle.raw.json<KubeObject>(resourcePath('', 'v1', 'pods', { namespace: p.namespace, name: p.name }));
      const spec = pod.spec as { containers?: Array<{ name: string }> } | undefined;
      const status = pod.status as { containerStatuses?: Array<{ name: string; state?: { running?: unknown } }> } | undefined;
      if (
        pod.metadata.deletionTimestamp ||
        !spec?.containers?.some((c) => c.name === p.container) ||
        !status?.containerStatuses?.some((c) => c.name === p.container && c.state?.running)
      )
        throw new HttpProblem(409, 'The selected application container is not running');
      manager.get(req.params.id);
      const interfaces = await readPodInterfaces(handle, p.namespace, p.name, p.container, controller.signal);
      manager.get(req.params.id);
      return { podUID: pod.metadata.uid ?? '', container: p.container, observedAt: new Date().toISOString(), interfaces };
    } catch (error) {
      sendError(reply, error);
      return reply;
    } finally {
      if (acquired) inspections--;
      reply.raw.off('close', cancel);
    }
  });
  // Public static bytes contain no credentials. Opaque sandbox origins need CORS
  // for module scripts; API routes remain authenticated and have no CORS grants.
  app.get<{ Params: { id: string; '*': string } }>('/plugin-assets/:id/*', async (req, reply) => {
    try {
      const data = manager.asset(req.params.id, req.params['*']);
      const base = `${req.protocol}://${req.host}/plugin-assets/${encodeURIComponent(req.params.id)}/`;
      return reply
        .header('access-control-allow-origin', '*')
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header(
          'content-security-policy',
          `sandbox allow-scripts; default-src 'none'; script-src ${base}; style-src ${base} 'unsafe-inline'; img-src ${base} data: blob:; font-src ${base} data:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
        )
        .type(mime[path.extname(req.params['*'])] ?? 'application/octet-stream')
        .send(data);
    } catch (error) {
      sendError(reply, error instanceof HttpProblem ? error : new HttpProblem(404, 'Plugin asset not found'));
      return reply;
    }
  });
}
