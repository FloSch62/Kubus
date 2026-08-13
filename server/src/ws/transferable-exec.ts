import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { EXEC_SESSION_CLOSE_REASON } from '@kubus/shared';

const REATTACH_GRACE_MS = 15_000;
const MAX_TRANSFER_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * A stable WebSocket-shaped facade whose browser socket can be replaced.
 * Kubernetes exec owns this facade, so moving a tab between renderers does
 * not close the upstream shell. Output is bounded and buffered while the new
 * window claims the session.
 */
export class TransferableExecSocket extends EventEmitter {
  readonly OPEN = 1;
  private current: WebSocket;
  private closed = false;
  private detached = false;
  private bufferingTransfer = false;
  private detachTimer: NodeJS.Timeout | undefined;
  private readonly controls = new Map<string, string>();
  private readonly transferBuffer: Buffer[] = [];
  private bufferedTransferBytes = 0;

  constructor(
    readonly terminalId: string,
    socket: WebSocket,
    private readonly reattachGraceMs = REATTACH_GRACE_MS,
  ) {
    super();
    this.current = socket;
    this.bind(socket);
  }

  get readyState(): number {
    return this.closed ? 3 : this.OPEN;
  }

  /** Attach a new renderer and atomically retire the previous browser socket. */
  attach(socket: WebSocket, cols: number, rows: number): boolean {
    if (this.closed) return false;
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
    this.detached = false;

    const previous = this.current;
    this.unbind(previous);
    this.current = socket;
    this.bind(socket);
    if (previous.readyState === previous.OPEN) previous.close(1000, 'terminal transferred');

    for (const frame of this.controls.values()) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
    this.bufferingTransfer = false;
    this.flushTransferBuffer();
    this.emit('message', Buffer.from(JSON.stringify({ op: 'resize', cols, rows })), false);
    return true;
  }

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      try {
        const control = JSON.parse(data) as { op?: unknown };
        if (typeof control.op === 'string' && control.op === 'session') this.controls.set(control.op, data);
      } catch {
        /* ordinary text frame */
      }
    }
    if (
      Buffer.isBuffer(data) &&
      options?.binary &&
      (this.bufferingTransfer || this.detached || this.current.readyState !== this.current.OPEN)
    ) {
      this.bufferTransferData(data);
      return;
    }
    if (this.current.readyState !== this.current.OPEN) return;
    if (options) this.current.send(data, options);
    else this.current.send(data);
  }

  ping(): void {
    if (this.current.readyState === this.current.OPEN) this.current.ping();
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    const socket = this.current;
    this.finish();
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  }

  private readonly handleMessage = (data: Buffer, isBinary: boolean): void => {
    if (!isBinary) {
      try {
        const control = JSON.parse(data.toString('utf8')) as { op?: unknown };
        if (control.op === 'prepare-transfer') {
          this.bufferingTransfer = true;
          if (this.current.readyState === this.current.OPEN) {
            this.current.send(JSON.stringify({ op: 'transfer-ready' }));
          }
          return;
        }
        if (control.op === 'cancel-transfer') {
          this.bufferingTransfer = false;
          this.flushTransferBuffer();
          return;
        }
      } catch {
        /* forwarded as terminal text below */
      }
    }
    this.emit('message', data, isBinary);
  };

  private readonly handleClose = (code: number, reason: Buffer): void => {
    if (this.closed || this.detached) return;
    if (code === 1000 && reason.toString('utf8') === EXEC_SESSION_CLOSE_REASON) {
      this.finish();
      return;
    }
    this.detached = true;
    if (this.reattachGraceMs <= 0) {
      this.finish();
      return;
    }
    this.detachTimer = setTimeout(() => {
      this.detachTimer = undefined;
      this.finish();
    }, this.reattachGraceMs);
    this.detachTimer.unref?.();
  };

  private bind(socket: WebSocket): void {
    socket.on('message', this.handleMessage);
    socket.once('close', this.handleClose);
  }

  private unbind(socket: WebSocket): void {
    socket.removeListener('message', this.handleMessage);
    socket.removeListener('close', this.handleClose);
  }

  private bufferTransferData(data: Buffer): void {
    let buffered = Buffer.from(data);
    if (buffered.byteLength >= MAX_TRANSFER_BUFFER_BYTES) {
      this.transferBuffer.length = 0;
      buffered = buffered.subarray(buffered.byteLength - MAX_TRANSFER_BUFFER_BYTES);
      this.bufferedTransferBytes = 0;
    }
    while (
      this.transferBuffer.length > 0 &&
      this.bufferedTransferBytes + buffered.byteLength > MAX_TRANSFER_BUFFER_BYTES
    ) {
      this.bufferedTransferBytes -= this.transferBuffer.shift()!.byteLength;
    }
    this.transferBuffer.push(buffered);
    this.bufferedTransferBytes += buffered.byteLength;
  }

  private flushTransferBuffer(): void {
    const buffered = this.transferBuffer.splice(0);
    this.bufferedTransferBytes = 0;
    if (this.current.readyState !== this.current.OPEN) return;
    for (const chunk of buffered) this.current.send(chunk, { binary: true });
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.detached = false;
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
    this.transferBuffer.length = 0;
    this.bufferedTransferBytes = 0;
    this.unbind(this.current);
    this.emit('close');
  }
}

/** Stable terminal identities shared by pod-shell and node-shell endpoints. */
export class ExecSessionRegistry {
  private readonly sessions = new Map<string, TransferableExecSocket>();

  create(socket: WebSocket, reattachGraceMs?: number): TransferableExecSocket {
    const terminalId = `terminal-${randomUUID()}`;
    const transferable = new TransferableExecSocket(terminalId, socket, reattachGraceMs);
    this.sessions.set(terminalId, transferable);
    transferable.once('close', () => this.sessions.delete(terminalId));
    transferable.send(JSON.stringify({ op: 'session', terminalId }));
    return transferable;
  }

  attach(terminalId: string, socket: WebSocket, cols: number, rows: number): boolean {
    return this.sessions.get(terminalId)?.attach(socket, cols, rows) ?? false;
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
