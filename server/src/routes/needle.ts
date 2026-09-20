import type { FastifyInstance } from 'fastify';
import type { KubeObject } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem, sendError } from '../util/errors.js';

export function registerNeedleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { ctx: string; plural: string }; Querystring: { namespace?: string; limit?: string; continue?: string } }>(
    '/api/contexts/:ctx/detail/resource-metadata/:plural', async (req, reply) => {
      try {
        const { plural } = req.params;
        if (!['secrets', 'configmaps'].includes(plural)) throw new HttpProblem(422, 'Only Secret and ConfigMap inventories are supported');
        const namespace = req.query.namespace || undefined;
        if (namespace && !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) throw new HttpProblem(422, 'Invalid namespace');
        const limit = Number(req.query.limit ?? 1000);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpProblem(422, 'Limit must be between 1 and 1000');
        const query = new URLSearchParams({ limit: String(limit) });
        if (req.query.continue) query.set('continue', req.query.continue);
        const handle = ctx.clusters.get(req.params.ctx);
        // Metadata negotiation avoids fetching secret values. No fallback to full objects.
        const response = await handle.raw.json<{ items: KubeObject[]; metadata?: { continue?: string } }>(resourcePath('', 'v1', plural, { namespace, query }), {
          headers: { Accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1' },
        });
        if (!Array.isArray(response.items)) throw new HttpProblem(502, 'Invalid metadata inventory');
        return { items: response.items.map((item) => ({ kind: plural === 'secrets' ? 'Secret' : 'ConfigMap', metadata: {
          name: item.metadata.name, namespace: item.metadata.namespace, uid: item.metadata.uid,
          creationTimestamp: item.metadata.creationTimestamp, labels: item.metadata.labels,
        } })), continue: response.metadata?.continue };
      } catch (error) { sendError(reply, error); return reply; }
    },
  );
  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string } }>('/api/contexts/:ctx/observations/terminations', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const namespace = req.query.namespace || undefined;
      // Recheck current list permissions before returning retained observations.
      await handle.raw.json(resourcePath('', 'v1', 'pods', { namespace, query: new URLSearchParams({ limit: '1' }) }));
      return handle.podObservations.snapshot(namespace);
    } catch (error) { sendError(reply, error); return reply; }
  });

  app.get<{ Params: { ctx: string }; Querystring: { namespace?: string; name?: string; uid?: string; container?: string; previous?: string } }>(
    '/api/contexts/:ctx/detail/pod-logs', async (req, reply) => {
      const controller = new AbortController();
      const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.on('close', onClose);
      try {
        const { namespace, name, uid, container, previous } = req.query;
        if (!namespace || !name || !uid || !container || (previous !== undefined && !['true', 'false'].includes(previous))) throw new HttpProblem(422, 'namespace, name, uid and container are required; previous must be true or false');
        const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
        if (!label.test(namespace) || !label.test(container) || name.length > 253 || !name.split('.').every((part) => label.test(part))) throw new HttpProblem(422, 'Invalid pod, namespace or container name');
        const handle = ctx.clusters.get(req.params.ctx);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
        const podPath = resourcePath('', 'v1', 'pods', { namespace, name });
        const check = async () => {
          const pod = await handle.raw.json<KubeObject>(podPath, { signal });
          if (pod.metadata.uid !== uid) throw new HttpProblem(409, 'Pod was replaced. Ask again to inspect its new identity.');
          return pod;
        };
        const pod = await check();
        const containers = [...(Array.isArray(pod.spec?.containers) ? pod.spec.containers : []), ...(Array.isArray(pod.spec?.initContainers) ? pod.spec.initContainers : []), ...(Array.isArray(pod.spec?.ephemeralContainers) ? pod.spec.ephemeralContainers : [])];
        if (!containers.some((entry) => entry.name === container)) throw new HttpProblem(422, 'Container is not part of this pod');
        const query = new URLSearchParams({ container, previous: previous ?? 'false', follow: 'false', tailLines: '80', limitBytes: '16384', timestamps: 'true' });
        const response = await handle.raw.stream(resourcePath('', 'v1', 'pods', { namespace, name, subresource: 'log', query }), { signal });
        const chunks: Buffer[] = [];
        let bytes = 0;
        if (response.body) for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          chunks.push(buffer.subarray(0, Math.max(0, 16384 - bytes)));
          bytes += buffer.length;
          if (bytes >= 16384) break;
        }
        await check();
        return { uid, container, previous: previous === 'true', text: Buffer.concat(chunks).toString('utf8'), truncated: bytes >= 16384 };
      } catch (error) { sendError(reply, error); return reply; }
      finally { reply.raw.off('close', onClose); }
    },
  );
}
