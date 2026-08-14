import net from 'node:net';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortForwardManager } from '../../../server/src/kube/portforward-manager.js';

const managers: PortForwardManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll();
});

describe('PortForwardManager connection lifecycle', () => {
  it('drops late Kubernetes frames and closes an upstream that connects after the local peer ends', async () => {
    let acceptConnection!: () => void;
    const connectionAccepted = new Promise<void>((resolve) => {
      acceptConnection = resolve;
    });
    let resolveUpstream!: (value: { close: () => void }) => void;
    const upstreamConnected = new Promise<{ close: () => void }>((resolve) => {
      resolveUpstream = resolve;
    });
    let output!: Writable;
    let input!: net.Socket;
    const portForward = vi.fn(
      async (
        _namespace: string,
        _pod: string,
        _ports: number[],
        forwardOutput: Writable,
        _error: Writable,
        forwardInput: net.Socket,
      ) => {
        output = forwardOutput;
        input = forwardInput;
        acceptConnection();
        return upstreamConnected;
      },
    );
    const handle = {
      raw: { json: vi.fn(async () => ({ status: { allowed: true } })) },
      makePortForward: () => ({ portForward }),
    };
    const manager = new PortForwardManager(
      { get: vi.fn(() => handle) } as never,
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    managers.push(manager);

    const forward = await manager.start('dev', {
      namespace: 'default',
      kind: 'pod',
      name: 'web-0',
      remotePort: 8080,
    });
    const client = net.connect(forward.localPort, '127.0.0.1');
    await once(client, 'connect');
    await connectionAccepted;

    const socketErrors: Error[] = [];
    input.on('error', (err) => socketErrors.push(err));
    input.once('end', () => {
      // Reproduce a WebSocket message delivered after FIN but before close.
      queueMicrotask(() => output.write(Buffer.from('late frame')));
    });
    client.end();
    await once(client, 'close');

    const upstream = { close: vi.fn() };
    resolveUpstream(upstream);
    await vi.waitFor(() => expect(upstream.close).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output).not.toBe(input);
    expect(socketErrors).toEqual([]);
  });
});
