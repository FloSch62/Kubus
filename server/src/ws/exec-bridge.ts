import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import type { ExecServerControl } from '@kubus/shared';
import { execClientControlSchema } from '@kubus/shared/ws-protocol';
import type { ClusterHandle } from '../kube/cluster-manager.js';

export interface ExecBridgeOptions {
  namespace: string;
  pod: string;
  container: string;
  command: string[];
  cols: number;
  rows: number;
  /** Invoked once when the bridge ends, regardless of cause (cleanup hook). */
  onClose?: () => void;
}

/**
 * Wire a browser WebSocket to a Kubernetes exec session. Browser -> server:
 * binary frames = stdin bytes; text frames = JSON control ({op:'resize'}).
 * Server -> browser: binary frames = output bytes; text frames = JSON
 * control ({op:'exit'}). Shared by pod shells and node shells.
 *
 * Resize plumbing: client-node's Exec looks for `columns`/`rows` and a
 * 'resize' event (terminal-size-queue) and forwards sizes on channel 4.
 * As of client-node 1.4 it watches stdout; older versions watched stdin —
 * decorate both so the size survives dependency bumps.
 */
export async function runExecBridge(socket: WebSocket, handle: ClusterHandle, opts: ExecBridgeOptions): Promise<void> {
  let closed = false;
  let keepalive: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    opts.onClose?.();
  };

  const sendControl = (msg: ExecServerControl) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  type Resizable = PassThrough & { columns: number; rows: number };
  const stdin = new PassThrough() as Resizable;
  const stdout = new PassThrough() as Resizable;
  stdin.columns = stdout.columns = opts.cols;
  stdin.rows = stdout.rows = opts.rows;

  const stderr = new PassThrough();
  const forward = (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
  };
  stdout.on('data', forward);
  stderr.on('data', forward);

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      stdin.write(data);
      return;
    }
    try {
      const parsed = execClientControlSchema.safeParse(JSON.parse(data.toString('utf8')));
      if (parsed.success && parsed.data.op === 'resize') {
        stdin.columns = stdout.columns = parsed.data.cols;
        stdin.rows = stdout.rows = parsed.data.rows;
        stdin.emit('resize');
        stdout.emit('resize');
      }
    } catch {
      // not JSON: treat text frames as input too (some clients send text)
      stdin.write(data.toString('utf8'));
    }
  });

  try {
    const upstream = await handle.makeExec().exec(opts.namespace, opts.pod, opts.container, opts.command, stdout, stderr, stdin, true, (status) => {
      const exitCode = status.details?.causes?.find((c) => c.reason === 'ExitCode')?.message;
      const code = status.status === 'Success' ? 0 : exitCode ? Number(exitCode) : 1;
      sendControl({ op: 'exit', code, message: status.message });
    });
    // Keepalive pings on both hops: idle exec sessions otherwise get culled
    // by intermediaries (SSH tunnels, LBs, kubelet idle timeout, dev proxy).
    keepalive = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
      if (upstream.readyState === upstream.OPEN) upstream.ping();
    }, 30_000);
    upstream.on('close', () => {
      sendControl({ op: 'exit' });
      cleanup();
      socket.close();
    });
    socket.on('close', () => {
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
      cleanup();
    });
  } catch (err) {
    sendControl({ op: 'exit', code: 1, message: err instanceof Error ? err.message : String(err) });
    cleanup();
    socket.close();
  }
}
