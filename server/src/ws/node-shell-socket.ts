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
    void (async () => {
      let cleanup: (() => void) | undefined;
      try {
        const handle = ctx.clusters.get(q.ctx ?? '');
        const node = q.node ?? '';
        if (!node) {
          sendExit('node is required');
          return;
        }
        if (socket.readyState === socket.OPEN) {
          socket.send(Buffer.from(`Starting privileged debug pod on ${node}…\r\n`), { binary: true });
        }
        const { namespace, pod, container } = await createNodeShellPod(handle, node);
        cleanup = () => {
          deleteNodeShellPod(handle, pod).catch((err) => app.log.warn({ pod, err: String(err) }, 'node-shell pod cleanup failed'));
        };
        if (socket.readyState !== socket.OPEN) {
          // Browser left while the pod was starting.
          cleanup();
          return;
        }
        await runExecBridge(socket, handle, {
          namespace,
          pod,
          container,
          command: NODE_SHELL_COMMAND,
          cols: Number(q.cols ?? 80) || 80,
          rows: Number(q.rows ?? 24) || 24,
          onClose: cleanup,
        });
      } catch (err) {
        cleanup?.();
        sendExit(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}
