import type { FastifyInstance } from 'fastify';
import type { KubeObject } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { resourcePath } from '../kube/raw-client.js';
import { HttpProblem, sendError } from '../util/errors.js';

export function registerNeedleRoutes(app: FastifyInstance, ctx: AppContext): void {
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
        const containers = [...(Array.isArray(pod.spec?.containers) ? pod.spec.containers : []), ...(Array.isArray(pod.spec?.initContainers) ? pod.spec.initContainers : [])];
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
