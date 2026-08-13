import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../app.js';
import { runExecBridge } from './exec-bridge.js';

const LOGIN_SHELLS = new Set(['sh', 'bash', 'ash', 'dash', 'ksh', 'zsh']);

function shellCommand(shell?: string): string[] {
  if (!shell) return ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l'];

  const name = shell.split('/').at(-1);
  return name && LOGIN_SHELLS.has(name) ? [shell, '-l'] : [shell];
}

/** Interactive shell into a container. One browser socket per terminal. */
export function registerExecSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/exec', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      const cols = Number(q.cols ?? 80) || 80;
      const rows = Number(q.rows ?? 24) || 24;
      if (q.terminalId) {
        if (!ctx.execSessions.attach(q.terminalId, socket, cols, rows)) {
          socket.send(JSON.stringify({ op: 'exit', code: 1, message: 'The terminal session is no longer available.' }));
          socket.close();
        }
        return;
      }
      const handle = ctx.clusters.get(q.ctx ?? '');
      // Login shells (-l) so /etc/profile.d is sourced — debug images
      // (debugbox, netshoot) define their helper functions there. Unknown
      // custom executables stay untouched because they may not accept -l.
      const command = shellCommand(q.shell);
      const transferable = ctx.execSessions.create(socket);
      void runExecBridge(transferable as unknown as WebSocket, handle, {
        namespace: q.namespace ?? '',
        pod: q.pod ?? '',
        container: q.container ?? '',
        command,
        cols,
        rows,
      });
    } catch (err) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ op: 'exit', code: 1, message: err instanceof Error ? err.message : String(err) }));
      }
      socket.close();
    }
  });
}
