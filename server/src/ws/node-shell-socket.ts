import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../app.js';
import type { DebugProfile } from '@kubus/shared';
import { createNodeDebugPod, createNodeShellPod, deleteNodeShellPod, NODE_DEBUG_COMMAND, NODE_DEBUG_ROOT, NODE_SHELL_COMMAND } from '../kube/node-shell.js';
import { runExecBridge } from './exec-bridge.js';

/**
 * Root shell on a node: create a privileged nsenter pod pinned to the node,
 * bridge the socket to it like a normal pod exec, and delete the pod when
 * the socket closes. With `image`, the pod is a kubectl-debug-node style
 * debug pod instead and the shell runs inside that image.
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
    // Leaving while the pod starts (a slow image pull) stops the wait and deletes it.
    const abandoned = new AbortController();
    transferable.once('close', () => abandoned.abort());
    void (async () => {
      let cleanup: (() => void) | undefined;
      try {
        const handle = ctx.clusters.get(q.ctx ?? '');
        const node = q.node ?? '';
        if (!node) {
          sendStableExit('node is required');
          return;
        }
        const say = (line: string) => {
          if (stableSocket.readyState === stableSocket.OPEN) stableSocket.send(Buffer.from(`${line}\r\n`), { binary: true });
        };
        const image = q.image?.trim();
        if (image) say(`Starting debug pod on ${node} with ${image}…`);
        else say(`Starting privileged debug pod on ${node}…`);
        const { namespace, pod, container } = image
          ? await createNodeDebugPod(handle, node, {
              image,
              profile: (q.profile || undefined) as DebugProfile | undefined,
              onWaiting: (reason) => say(reason === 'ContainerCreating' ? '  creating container (pulls the image if the node lacks it)' : `  ${reason}`),
              signal: abandoned.signal,
            })
          : await createNodeShellPod(handle, node, abandoned.signal);
        cleanup = () => {
          deleteNodeShellPod(handle, pod).catch((err) => app.log.warn({ pod, err: String(err) }, 'node-shell pod cleanup failed'));
        };
        if (stableSocket.readyState !== stableSocket.OPEN) {
          // Browser left while the pod was starting.
          cleanup();
          return;
        }
        if (image) say(`\x1b[90mNode root filesystem is at ${NODE_DEBUG_ROOT} (chroot ${NODE_DEBUG_ROOT} for the node's own tools). The pod is deleted when this terminal closes.\x1b[0m`);
        await runExecBridge(stableSocket, handle, {
          namespace,
          pod,
          container,
          command: image ? NODE_DEBUG_COMMAND : NODE_SHELL_COMMAND,
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
