import posix from 'node:path/posix';
import { PassThrough, type Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { runCommand, streamCommand } from '../kube/file-copy.js';
import { HttpProblem, sendError } from '../util/errors.js';

const DOWNLOAD_LIMIT = 512 * 1024 * 1024; // 512 MiB

interface FileQuery {
  namespace?: string;
  pod?: string;
  container?: string;
  path?: string;
  untar?: string;
}

function requireParams(q: FileQuery): { namespace: string; pod: string; container: string; path: string } {
  const { namespace, pod, container, path } = q;
  if (!namespace || !pod || !container || !path) throw new HttpProblem(422, 'namespace, pod, container and path are required');
  if (!posix.isAbsolute(path)) throw new HttpProblem(422, 'path must be absolute');
  return { namespace, pod, container, path };
}

/**
 * kubectl cp equivalent over the exec API. Commands are passed as argv
 * arrays (no shell, no quoting) and run without a TTY so the byte streams
 * stay binary-safe. Requires cat/tee/tar inside the container — their
 * stderr is returned verbatim so distroless failures are self-explanatory.
 */
export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Raw stream passthrough for uploads — no buffering, no body limit.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  app.get<{ Params: { ctx: string }; Querystring: FileQuery }>('/api/contexts/:ctx/files/download', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const { namespace, pod, container, path } = requireParams(req.query);

      const probe = await runCommand(handle, namespace, pod, container, ['test', '-d', path]);
      const isDir = probe.code === 0;
      const base = posix.basename(path) || 'download';
      const command = isDir ? ['tar', 'cf', '-', '-C', posix.dirname(path), base] : ['cat', path];

      const stream = await streamCommand(handle, namespace, pod, container, command);

      // Attach the relay before anything can put stdout into flowing mode —
      // a bare once('data') here would swallow the first chunk(s). The relay
      // buffers; nothing is consumed until reply.send attaches a reader.
      let bytes = 0;
      const relay = new PassThrough();
      stream.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > DOWNLOAD_LIMIT) {
          app.log.warn({ path, bytes }, 'file download truncated at size limit');
          stream.abort();
          relay.destroy(new Error('download exceeds 512 MiB limit'));
        }
      });
      stream.stdout.pipe(relay);

      // Wait for the first byte or an early failure so errors (no such
      // file, tool missing) become a proper HTTP error instead of an empty
      // 200 download. 'readable' peeks without consuming; with an empty
      // buffer it signals EOF, in which case the exit status decides.
      const first = await Promise.race([
        new Promise<{ kind: 'data' | 'eof' }>((res) => {
          const onReadable = () => {
            relay.off('readable', onReadable);
            res({ kind: relay.readableLength > 0 ? 'data' : 'eof' });
          };
          relay.on('readable', onReadable);
        }),
        stream.outcome.then((o) => ({ kind: 'outcome' as const, ...o })),
      ]);
      if (first.kind !== 'data') {
        const o = first.kind === 'outcome' ? first : await stream.outcome;
        if (o.code !== 0) throw new HttpProblem(500, o.stderr || `command exited with code ${o.code}`);
      }
      void stream.outcome.then((o) => {
        if (o.code !== 0) app.log.warn({ path, code: o.code, stderr: o.stderr }, 'file download command failed mid-stream');
      });

      const filename = isDir ? `${base}.tar` : base;
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      return reply.send(relay);
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });

  app.post<{ Params: { ctx: string }; Querystring: FileQuery; Body: Readable }>('/api/contexts/:ctx/files/upload', async (req, reply) => {
    try {
      const handle = ctx.clusters.get(req.params.ctx);
      const { namespace, pod, container, path } = requireParams(req.query);
      const untar = req.query.untar === 'true';
      const command = untar ? ['tar', 'xf', '-', '-C', path] : ['tee', path];

      // Count bytes on the request stream, not on `relay`: a data listener
      // on relay would drain it (and fire 'end') before the exec websocket
      // attaches its stdin handlers, losing the data and the EOF signal.
      let bytes = 0;
      req.body.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      const relay = new PassThrough();
      req.body.pipe(relay);

      const outcome = await runCommand(handle, namespace, pod, container, command, { stdin: relay });
      if (outcome.code !== 0) throw new HttpProblem(500, outcome.stderr || `command exited with code ${outcome.code}`);
      return { ok: true, bytes };
    } catch (err) {
      sendError(reply, err);
      return reply;
    }
  });
}
