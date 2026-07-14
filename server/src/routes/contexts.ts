import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TestConnectionResponse } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { HttpProblem, sendError } from '../util/errors.js';

const nullableString = z.string().nullable().or(z.literal(''));
const setSshHostSchema = z.object({
  sshHost: z
    .string()
    .trim()
    .max(256)
    .regex(/^(ssh:\/\/)?[A-Za-z0-9][A-Za-z0-9._~%@:[\]-]*$/, 'SSH jump host must be an ssh config alias, user@host or ssh://user@host:port')
    .nullable()
    .or(z.literal('')),
});
const editClusterSchema = z.object({
  server: z.string().trim().regex(/^https?:\/\//i, 'API server URL must start with http:// or https://'),
  skipTlsVerify: z.boolean(),
  caPem: nullableString,
  proxyUrl: z
    .string()
    .trim()
    .regex(/^(socks5?|socks5h|https?):\/\//i, 'proxy URL must start with socks5://, socks5h://, http:// or https://')
    .nullable()
    .or(z.literal('')),
  sshHost: z
    .string()
    .trim()
    .max(256)
    .regex(/^(ssh:\/\/)?[A-Za-z0-9][A-Za-z0-9._~%@:[\]-]*$/, 'SSH jump host must be an ssh config alias, user@host or ssh://user@host:port')
    .nullable()
    .or(z.literal(''))
    .optional(),
  tlsServerName: nullableString,
  auth: z.discriminatedUnion('method', [
    z.object({ method: z.literal('keep') }),
    z.object({ method: z.literal('token'), token: z.string().min(1, 'token is required') }),
    z.object({
      method: z.literal('client-cert'),
      clientCertPem: z.string().min(1, 'client certificate is required'),
      clientKeyPem: z.string().min(1, 'client key is required'),
    }),
  ]),
});

export function registerContextRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/contexts', async () => ctx.clusters.listContexts());

  app.post<{ Params: { ctx: string } }>('/api/contexts/:ctx/test', async (req, reply): Promise<TestConnectionResponse | undefined> => {
    try {
      return await ctx.clusters.test(req.params.ctx);
    } catch (err) {
      sendError(reply, err);
      return undefined;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/ca', async (req, reply): Promise<{ pem: string | null } | undefined> => {
    try {
      return { pem: ctx.clusters.getClusterCa(req.params.ctx) };
    } catch (err) {
      sendError(reply, err);
      return undefined;
    }
  });

  app.put<{ Params: { ctx: string } }>('/api/contexts/:ctx/cluster', async (req, reply) => {
    try {
      const parsed = editClusterSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid body', 'BadRequest');
      const d = parsed.data;
      if (d.proxyUrl && d.sshHost) {
        throw new HttpProblem(400, 'choose either an SSH jump host or a proxy URL, not both', 'BadRequest');
      }
      ctx.clusters.editCluster(req.params.ctx, {
        server: d.server,
        skipTlsVerify: d.skipTlsVerify,
        caPem: d.caPem || null,
        proxyUrl: d.proxyUrl || null,
        tlsServerName: d.tlsServerName || null,
        auth: d.auth,
      });
      // Only touch the tunnel mapping when the client sends the field, so
      // older clients that omit it can't silently clear an existing jump host.
      if (d.sshHost !== undefined) ctx.clusters.setSshHost(req.params.ctx, d.sshHost || null);
      return ctx.clusters.listContexts();
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.put<{ Params: { ctx: string } }>('/api/contexts/:ctx/ssh-host', async (req, reply) => {
    try {
      const parsed = setSshHostSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid body', 'BadRequest');
      ctx.clusters.setSshHost(req.params.ctx, parsed.data.sshHost || null);
      return ctx.clusters.listContexts();
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string } }>('/api/contexts/:ctx/connect', async (req, reply) => {
    try {
      await ctx.clusters.connect(req.params.ctx);
      return ctx.clusters.listContexts();
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.delete<{ Params: { ctx: string } }>('/api/contexts/:ctx/connect', async (req) => {
    ctx.clusters.disconnect(req.params.ctx);
    return ctx.clusters.listContexts();
  });

  app.post<{ Params: { ctx: string } }>('/api/contexts/:ctx/reconnect', async (req, reply) => {
    try {
      await ctx.clusters.reconnect(req.params.ctx);
      return ctx.clusters.listContexts();
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/api-resources', async (req, reply) => {
    try {
      return await ctx.clusters.get(req.params.ctx).discovery.getResources();
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string } }>('/api/contexts/:ctx/namespaces', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const { watcher, release } = handle.watchers.acquire('', 'v1', 'namespaces');
      try {
        await watcher.ready();
        return watcher
          .items()
          .map((ns) => ns.metadata.name)
          .sort();
      } finally {
        release();
      }
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.get<{ Params: { ctx: string }; Querystring: { involvedName?: string; involvedKind?: string; namespace?: string } }>('/api/contexts/:ctx/events', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const { involvedName, involvedKind, namespace } = req.query;
      const selectors: string[] = [];
      if (involvedName) selectors.push(`involvedObject.name=${involvedName}`);
      if (involvedKind) selectors.push(`involvedObject.kind=${involvedKind}`);
      const query = new URLSearchParams();
      if (selectors.length) query.set('fieldSelector', selectors.join(','));
      const path = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` : '/api/v1/events';
      const result = await handle.raw.json<{ items?: unknown[] }>(`${path}?${query.toString()}`);
      return { items: result.items ?? [] };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
