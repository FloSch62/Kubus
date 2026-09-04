import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ExecServerControl } from '@kubus/shared';
import { execClientControlSchema } from '@kubus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { defaultShellCwd, spawnShell, type ShellProcess } from '../local-shell/pty.js';
import { removeSessionKubeconfig, singleContextKubeconfig, sweepStaleSessionKubeconfigs, writeSessionKubeconfig } from '../local-shell/kubeconfig.js';

/** An executable path: spaces are fine (`C:\Program Files\PowerShell\7\pwsh.exe` is spawned directly, never through a command shell). */
const SHELL_PATH_RE = /^[A-Za-z0-9_./\\:+ -]+$/;

/**
 * A shell on the machine Kubus runs on, pointed at the cluster and namespace
 * the UI is looking at. Browser -> server: binary frames are keystrokes, text
 * frames are JSON control (resize, context switch, transfer handshake).
 * Server -> browser: binary frames are terminal output, text frames are
 * control (session id, the kubeconfig in effect, exit).
 */
export function registerLocalShellSocket(app: FastifyInstance, ctx: AppContext): void {
  const swept = sweepStaleSessionKubeconfigs();
  if (swept.length) app.log.info({ count: swept.length }, 'removed terminal kubeconfigs left by an earlier server');
  app.get('/ws/local-shell', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>;
    const cols = Number(q.cols ?? 80) || 80;
    const rows = Number(q.rows ?? 24) || 24;
    if (q.terminalId) {
      if (!ctx.execSessions.attach(q.terminalId, socket, cols, rows)) {
        socket.send(JSON.stringify({ op: 'exit', code: 1, message: 'The terminal session is no longer available.' }));
        socket.close();
      }
      return;
    }
    const transferable = ctx.execSessions.create(socket);
    const stable = transferable as unknown as WebSocket;
    const sendControl = (msg: ExecServerControl) => {
      if (stable.readyState === stable.OPEN) stable.send(JSON.stringify(msg));
    };
    const fail = (message: string) => {
      sendControl({ op: 'exit', code: 1, message });
      stable.close();
    };

    const sessionId = transferable.terminalId;
    let current: { ctx: string; namespace?: string } = { ctx: q.ctx ?? '', namespace: q.namespace || undefined };
    let proc: ShellProcess | undefined;
    let closed = false;
    let keepalive: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      proc?.kill();
      removeSessionKubeconfig(sessionId);
    };

    /** Point the session's kubeconfig at a context; the next kubectl picks it up. */
    const pointAt = (target: { ctx: string; namespace?: string }): string => {
      const full = ctx.clusters.exportKubeconfig(target.ctx);
      const kubeconfigPath = writeSessionKubeconfig(sessionId, singleContextKubeconfig(full, target.ctx, target.namespace));
      current = target;
      return kubeconfigPath;
    };

    void (async () => {
      let kubeconfigPath: string;
      try {
        if (!current.ctx) throw new Error('ctx is required');
        kubeconfigPath = pointAt(current);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      const shell = q.shell && SHELL_PATH_RE.test(q.shell) ? q.shell : undefined;
      try {
        proc = await spawnShell({
          shell,
          cwd: defaultShellCwd(),
          // The kubeconfig is the one source of truth: it is rewritten on every
          // context switch and read afresh by each kubectl run, whereas a
          // variable copied into the child's environment would go stale.
          env: {
            ...process.env,
            KUBECONFIG: kubeconfigPath,
            KUBUS_TERMINAL: '1',
          },
          cols,
          rows,
        });
      } catch (err) {
        cleanup();
        fail(`could not start a shell: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (stable.readyState !== stable.OPEN) {
        cleanup();
        return;
      }
      const started = proc;
      sendControl({ op: 'context', ctx: current.ctx, namespace: current.namespace, kubeconfigPath, pty: started.pty });
      if (!started.pty) {
        stable.send(Buffer.from('\x1b[33m[kubus] No pseudo-terminal is available, so line editing and full-screen programs will not work. Install node-pty for a full terminal.\x1b[0m\r\n'), { binary: true });
      }
      started.onData((chunk) => {
        if (stable.readyState === stable.OPEN) stable.send(chunk, { binary: true });
      });
      started.onExit((code) => {
        sendControl({ op: 'exit', code: code ?? 0 });
        cleanup();
        stable.close();
      });
      keepalive = setInterval(() => {
        if (stable.readyState === stable.OPEN) stable.ping();
      }, 30_000);
      keepalive.unref();
    })();

    stable.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        proc?.write(data);
        return;
      }
      let parsed: ReturnType<typeof execClientControlSchema.safeParse>;
      try {
        parsed = execClientControlSchema.safeParse(JSON.parse(data.toString('utf8')));
      } catch {
        proc?.write(data.toString('utf8'));
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.op === 'resize') {
        proc?.resize(msg.cols, msg.rows);
      } else if (msg.op === 'context') {
        try {
          const kubeconfigPath = pointAt({ ctx: msg.ctx, namespace: msg.namespace || undefined });
          sendControl({ op: 'context', ctx: msg.ctx, namespace: msg.namespace || undefined, kubeconfigPath, pty: proc?.pty ?? false });
        } catch (err) {
          app.log.warn({ err: String(err), ctx: msg.ctx }, 'local shell could not switch context');
        }
      }
    });
    stable.on('close', cleanup);
  });
}
