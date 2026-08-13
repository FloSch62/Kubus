import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { EXEC_SESSION_CLOSE_REASON } from '@kubus/shared';
import { ExecSessionRegistry, TransferableExecSocket } from '../../../server/src/ws/transferable-exec.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: Array<{ data: string | Buffer; binary?: boolean }> = [];

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({ data, binary: options?.binary });
  }

  ping(): void {}

  close(code = 1000, reason = ''): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  receive(value: unknown): void {
    this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), false);
  }
}

describe('transferable Kubernetes exec sessions', () => {
  it('freezes output, swaps renderers, replays identity, and flushes buffered bytes in order', () => {
    const source = new FakeSocket();
    const registry = new ExecSessionRegistry();
    const stable = registry.create(source as never);
    const controls: Array<Record<string, unknown>> = [];
    stable.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) controls.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });

    const session = JSON.parse(String(source.sent[0]?.data)) as { terminalId: string };
    source.receive({ op: 'prepare-transfer' });
    expect(source.sent.map((frame) => String(frame.data))).toContain(JSON.stringify({ op: 'transfer-ready' }));

    stable.send(Buffer.from('first\r\n'), { binary: true });
    expect(source.sent.some((frame) => Buffer.isBuffer(frame.data) && frame.data.toString() === 'first\r\n')).toBe(false);

    const destination = new FakeSocket();
    expect(registry.attach(session.terminalId, destination as never, 132, 43)).toBe(true);
    expect(destination.sent.map((frame) => String(frame.data))).toEqual([
      JSON.stringify({ op: 'session', terminalId: session.terminalId }),
      'first\r\n',
    ]);
    expect(controls).toContainEqual({ op: 'resize', cols: 132, rows: 43 });
    expect(source.readyState).toBe(3);
  });

  it('keeps an unexpectedly detached renderer attachable during the grace period', () => {
    vi.useFakeTimers();
    const source = new FakeSocket();
    const stable = new TransferableExecSocket('terminal-grace', source as never, 1_000);
    const closed = vi.fn();
    stable.on('close', closed);

    source.close(1006, 'renderer gone');
    vi.advanceTimersByTime(900);
    const destination = new FakeSocket();
    expect(stable.attach(destination as never, 80, 24)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(closed).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('ends immediately for an intentional tab close', () => {
    const source = new FakeSocket();
    const stable = new TransferableExecSocket('terminal-close', source as never);
    const closed = vi.fn();
    stable.on('close', closed);

    source.close(1000, EXEC_SESSION_CLOSE_REASON);
    expect(closed).toHaveBeenCalledOnce();
    expect(stable.readyState).toBe(3);
  });
});
