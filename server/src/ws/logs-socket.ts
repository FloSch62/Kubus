import { Writable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { LOG_SOCKET_COMPLETE_CODE, LOG_SOCKET_NO_STREAMS_CODE, type LogServerMessage } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { podContainers } from '../kube/actions.js';

type StreamResult = 'ended' | 'error';

function containerHasTerminated(pod: unknown, container: string): boolean {
  const status = (pod as {
    status?: {
      containerStatuses?: Array<{ name?: string; state?: { terminated?: unknown } }>;
      initContainerStatuses?: Array<{ name?: string; state?: { terminated?: unknown } }>;
    };
  } | undefined)?.status;
  return [...(status?.containerStatuses ?? []), ...(status?.initContainerStatuses ?? [])].some(
    (entry) => entry.name === container && entry.state?.terminated !== undefined,
  );
}

/**
 * One socket per log session. Query params:
 *   ctx, namespace, pods (comma-separated), containers (comma-separated),
 *   container (legacy singular selection; '' = all containers), resumeAt
 *   (JSON object keyed by "pod/container" with RFC3339 timestamps),
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
    const selectedContainers = q.containers !== undefined
      ? new Set(q.containers.split(',').filter(Boolean))
      : container
        ? new Set([container])
        : undefined;
    const follow = q.follow !== 'false';
    const tailLines = q.tailLines !== undefined ? Number(q.tailLines) : undefined;
    const sinceSeconds = q.sinceSeconds ? Number(q.sinceSeconds) : undefined;
    const previous = q.previous === 'true';
    const resumeAt: Record<string, string> = {};
    if (q.resumeAt) {
      try {
        const parsed = JSON.parse(q.resumeAt) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && Number.isFinite(Date.parse(value))) resumeAt[key] = value;
          }
        }
      } catch {
        // A malformed cursor should not prevent a fresh stream.
      }
    }

    const send = (msg: LogServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const aborts: AbortController[] = [];
    const sinks = new Set<Writable>();
    let closed = false;
    let closing = false;

    const closeSocket = (code: number, reason: string) => {
      if (closed || closing || socket.readyState !== socket.OPEN) return;
      closing = true;
      socket.close(code, reason);
    };

    const streamOne = async (pod: string, containerName: string): Promise<StreamResult> => {
      // Line-splitter writable that forwards tagged frames.
      let buffer = '';
      let settled = false;
      let settle!: (result: StreamResult) => void;
      const completion = new Promise<StreamResult>((resolve) => {
        settle = resolve;
      });
      let sink: Writable;
      const complete = (result: StreamResult) => {
        if (settled) return;
        settled = true;
        sinks.delete(sink);
        settle(result);
      };
      const forwardLine = (raw: string) => {
        if (!raw) return;
        // With timestamps: "2026-01-02T03:04:05.000000000Z the line"
        const space = raw.indexOf(' ');
        const ts = space > 0 ? raw.slice(0, space) : undefined;
        const line = space > 0 ? raw.slice(space + 1) : raw;
        send({ op: 'line', pod, container: containerName, ts, line });
      };
      sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          buffer += chunk.toString('utf8');
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            forwardLine(raw);
          }
          cb();
        },
        final(cb) {
          forwardLine(buffer);
          send({ op: 'pod-status', pod, container: containerName, state: 'ended' });
          complete('ended');
          cb();
        },
        destroy(_err, cb) {
          complete('ended');
          cb();
        },
      });
      sinks.add(sink);
      sink.on('unpipe', () => {
        queueMicrotask(() => {
          if (settled || closed) return;
          send({ op: 'pod-status', pod, container: containerName, state: 'error', message: 'Upstream log stream closed before completion' });
          complete('error');
        });
      });

      try {
        const handle = ctx.clusters.get(ctxName);
        const sinceTime = resumeAt[`${pod}/${containerName}`];
        send({ op: 'pod-status', pod, container: containerName, state: 'streaming' });
        const abort = await handle.makeLog().log(namespace, pod, containerName, sink, {
          follow,
          tailLines: !sinceTime && tailLines !== undefined && Number.isFinite(tailLines) ? tailLines : undefined,
          sinceSeconds: !sinceTime && sinceSeconds !== undefined && Number.isFinite(sinceSeconds) ? sinceSeconds : undefined,
          sinceTime,
          previous,
          timestamps: true,
        });
        if (closed) abort.abort();
        else aborts.push(abort);
        return await completion;
      } catch (err) {
        send({ op: 'pod-status', pod, container: containerName, state: 'error', message: err instanceof Error ? err.message : String(err) });
        sink.destroy();
        return 'error';
      }
    };

    void (async () => {
      try {
        const handle = ctx.clusters.get(ctxName);
        const streams: Array<Promise<StreamResult>> = [];
        await Promise.all(pods.map(async (pod) => {
          if (closed || closing) return;
          // Resolve the pod spec even for a multi-container selection so names
          // that do not exist on this particular replica are ignored.
          const podObj = await handle.core.readNamespacedPod({ name: pod, namespace }).catch(() => undefined);
          if (closed || closing) return;
          let containers = podObj ? podContainers(podObj as never) : selectedContainers ? [...selectedContainers] : [''];
          if (selectedContainers) containers = containers.filter((name) => selectedContainers.has(name));
          if (!containers.length) {
            send({ op: 'pod-status', pod, container: '', state: 'error', message: 'No selected containers are available in this pod' });
            return;
          }
          for (const c of containers) {
            const containerName = c || '';
            const retryOnFinish = follow && !containerHasTerminated(podObj, containerName);
            streams.push(
              streamOne(pod, containerName).then((result) => {
                if (retryOnFinish) {
                  closeSocket(1011, result === 'error' ? 'upstream log stream failed' : 'upstream log stream ended');
                }
                return result;
              }),
            );
          }
        }));
        if (!streams.length) {
          closeSocket(LOG_SOCKET_NO_STREAMS_CODE, 'no log streams available');
          return;
        }
        const results = await Promise.all(streams);
        if (results.every((result) => result === 'error')) {
          closeSocket(LOG_SOCKET_NO_STREAMS_CODE, 'all log streams failed');
        } else {
          closeSocket(LOG_SOCKET_COMPLETE_CODE, 'log session complete');
        }
      } catch (err) {
        send({ op: 'pod-status', pod: '', container: '', state: 'error', message: err instanceof Error ? err.message : String(err) });
        closeSocket(1011, 'log session failed');
      }
    })();

    socket.on('close', () => {
      closed = true;
      for (const abort of aborts) abort.abort();
      for (const sink of sinks) sink.destroy();
      sinks.clear();
    });
  });
}
