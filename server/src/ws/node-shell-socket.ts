import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../app.js';
import { createNodeShellPod, deleteNodeShellPod, NODE_SHELL_COMMAND } from '../kube/node-shell.js';
import { runExecBridge } from './exec-bridge.js';

/**
 * Root shell on a node: create a privileged nsenter pod pinned to the node,
 * bridge the socket to it like a normal pod exec, and delete the pod when
 * the socket closes.
 */
export function registerNodeShellSocket(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/node-shell', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>;
    const sendExit = (message: string) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ op: 'exit', code: 1, message }));
      socket.close();
    };
    const cols = Number(q.cols ?? 80) || 80;
    const rows = Number(q.rows ?? 24) || 24;
    if (q.terminalId) {
      if (!ctx.execSessions.attach(q.terminalId, socket, cols, rows)) sendExit('The terminal session is no longer available.');
      return;
    }
    const transferable = ctx.execSessions.create(socket);
    const stableSocket = transferable as unknown as WebSocket;
    const sendStableExit = (message: string) => {
      if (stableSocket.readyState === stableSocket.OPEN) stableSocket.send(JSON.stringify({ op: 'exit', code: 1, message }));
      stableSocket.close();
    };
    void (async () => {
      let cleanup: (() => void) | undefined;
      try {
        const handle = ctx.clusters.get(q.ctx ?? '');
        const node = q.node ?? '';
        if (!node) {
          sendStableExit('node is required');
          return;
        }
        if (stableSocket.readyState === stableSocket.OPEN) {
          stableSocket.send(Buffer.from(`Starting privileged debug pod on ${node}…\r\n`), { binary: true });
        }
        const { namespace, pod, container } = await createNodeShellPod(handle, node);
        cleanup = () => {
          deleteNodeShellPod(handle, pod).catch((err) => app.log.warn({ pod, err: String(err) }, 'node-shell pod cleanup failed'));
        };
        if (stableSocket.readyState !== stableSocket.OPEN) {
          // Browser left while the pod was starting.
          cleanup();
          return;
        }
        await runExecBridge(stableSocket, handle, {
          namespace,
          pod,
          container,
          command: NODE_SHELL_COMMAND,
          cols,
          rows,
          onClose: cleanup,
        });
      } catch (err) {
        cleanup?.();
        sendStableExit(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}
