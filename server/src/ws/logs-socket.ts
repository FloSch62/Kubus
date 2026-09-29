import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { LOG_SOCKET_NO_STREAMS_CODE, type LogServerMessage } from '@kubus/shared';
import { logSocketQuerySchema } from '@kubus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { LogSession } from './log-session.js';

/**
 * One socket per log session; see logSocketQuerySchema for the query. The
 * server fans IN multiple pod/container streams and forwards each line as a
 * JSON frame tagged with its origin. Workload sessions (`target`) follow the
 * workload's pods through rollouts; `pods` sessions read a fixed set.
 */
export function registerLogsSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/logs', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    let closed = false;
    let closing = false;
    const send = (msg: LogServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const closeSocket = (code: number, reason: string) => {
      if (closed || closing || socket.readyState !== socket.OPEN) return;
      closing = true;
      socket.close(code, reason);
    };

    const parsed = logSocketQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      send({ op: 'pod-status', pod: '', container: '', state: 'error', message: `Invalid log request: ${parsed.error.issues[0]?.message ?? 'bad query'}` });
      closeSocket(LOG_SOCKET_NO_STREAMS_CODE, 'invalid log request');
      return;
    }

    const session = new LogSession(() => ctx.clusters.get(parsed.data.ctx), parsed.data, { send, close: closeSocket });
    socket.on('close', () => {
      closed = true;
      session.dispose();
    });
    void session.start();
  });
}
