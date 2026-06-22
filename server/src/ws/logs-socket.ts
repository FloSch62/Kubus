import { Writable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { LogServerMessage } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { podContainers } from '../kube/actions.js';

/**
 * One socket per log session. Query params:
 *   ctx, namespace, pods (comma-separated), container ('' = all containers),
 *   follow, tailLines, sinceSeconds, previous, timestamps are parsed per session.
 * The server fans IN multiple pod/container streams and forwards each line
 * as a JSON frame tagged with its origin.
 */
export function registerLogsSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/logs', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>;
    const ctxName = q.ctx ?? '';
    const namespace = q.namespace ?? '';
    const pods = (q.pods ?? '').split(',').filter(Boolean);
    const container = q.container || undefined;
    const follow = q.follow !== 'false';
    const tailLines = q.tailLines !== undefined ? Number(q.tailLines) : undefined;
    const sinceSeconds = q.sinceSeconds ? Number(q.sinceSeconds) : undefined;
    const previous = q.previous === 'true';

    const send = (msg: LogServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const aborts: AbortController[] = [];
    let closed = false;

    const streamOne = async (pod: string, containerName: string) => {
      // Line-splitter writable that forwards tagged frames.
      let buffer = '';
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          buffer += chunk.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!raw) continue;
            // With timestamps: "2026-01-02T03:04:05.000000000Z the line"
            const space = raw.indexOf(' ');
            const ts = space > 0 ? raw.slice(0, space) : undefined;
            const line = space > 0 ? raw.slice(space + 1) : raw;
            send({ op: 'line', pod, container: containerName, ts, line });
          }
          cb();
        },
        final(cb) {
          if (buffer) send({ op: 'line', pod, container: containerName, line: buffer });
          send({ op: 'pod-status', pod, container: containerName, state: 'ended' });
          cb();
        },
      });

      try {
        const handle = ctx.clusters.get(ctxName);
        send({ op: 'pod-status', pod, container: containerName, state: 'streaming' });
        const abort = await handle.makeLog().log(namespace, pod, containerName, sink, {
          follow,
          tailLines: tailLines !== undefined && Number.isFinite(tailLines) ? tailLines : undefined,
          sinceSeconds: sinceSeconds !== undefined && Number.isFinite(sinceSeconds) ? sinceSeconds : undefined,
          previous,
          timestamps: true,
        });
        aborts.push(abort);
      } catch (err) {
        send({ op: 'pod-status', pod, container: containerName, state: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };

    void (async () => {
      try {
        const handle = ctx.clusters.get(ctxName);
        for (const pod of pods) {
          if (closed) return;
          let containers: string[];
          if (container) {
            containers = [container];
          } else {
            // Resolve all containers from the pod spec.
            const podObj = await handle.core.readNamespacedPod({ name: pod, namespace }).catch(() => undefined);
            containers = podObj ? podContainers(podObj as never) : [''];
            if (!containers.length) containers = [''];
          }
          for (const c of containers) {
            void streamOne(pod, c || '');
          }
        }
      } catch (err) {
        send({ op: 'pod-status', pod: '', container: '', state: 'error', message: err instanceof Error ? err.message : String(err) });
        socket.close();
      }
    })();

    socket.on('close', () => {
      closed = true;
      for (const abort of aborts) abort.abort();
    });
  });
}
