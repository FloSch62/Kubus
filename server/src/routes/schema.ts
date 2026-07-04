import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { gvkJsonSchema } from '../kube/openapi-schema.js';
import { HttpProblem, sendError } from '../util/errors.js';

export function registerSchemaRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** JSON Schema for a group/version/kind, derived from the cluster's OpenAPI v3 (includes CRDs). */
  app.get<{ Params: { ctx: string }; Querystring: { group?: string; version?: string; kind?: string } }>(
    '/api/contexts/:ctx/schema',
    async (req, reply) => {
      try {
        const { group = '', version, kind } = req.query;
        if (!version || !kind) throw new HttpProblem(422, 'version and kind are required');
        const handle = ctx.clusters.get(req.params.ctx);
        return await gvkJsonSchema(handle, group, version, kind);
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    },
  );
}
