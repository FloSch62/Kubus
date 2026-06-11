import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../app.js';
import { runExecBridge } from './exec-bridge.js';

/** Interactive shell into a container. One browser socket per terminal. */
export function registerExecSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/exec', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      const handle = ctx.clusters.get(q.ctx ?? '');
      const shell = q.shell;
      const command = shell ? [shell] : ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'];
      void runExecBridge(socket, handle, {
        namespace: q.namespace ?? '',
        pod: q.pod ?? '',
        container: q.container ?? '',
        command,
        cols: Number(q.cols ?? 80) || 80,
        rows: Number(q.rows ?? 24) || 24,
      });
    } catch (err) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ op: 'exit', code: 1, message: err instanceof Error ? err.message : String(err) }));
      }
      socket.close();
    }
  });
}
