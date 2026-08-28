import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../../server/src/server';

let server: RunningServer | undefined;
let socket: net.Socket | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  socket?.destroy();
  await server?.close().catch(() => undefined);
  socket = undefined;
  server = undefined;
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('closes promptly when a WebSocket peer does not answer the close handshake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubus-app-shutdown-'));
  tempDirs.push(root);
  const kubeconfig = path.join(root, 'kubeconfig');
  fs.writeFileSync(kubeconfig, 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\ncurrent-context: ""\n');
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));

  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test',
    openBrowser: false,
    prettyLogs: false,
    staticRoot: path.join(root, 'missing-client'),
    kubeconfigOverride: kubeconfig,
  });
  socket = net.createConnection({ host: '127.0.0.1', port: server.port });
  await once(socket, 'connect');
  socket.write(
    [
      'GET /ws/watch?token=test HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  let response = '';
  while (!response.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    response += String(chunk);
  }
  expect(response).toContain('101 Switching Protocols');

  await expect(server.close()).resolves.toBeUndefined();
  server = undefined;
  await expect.poll(() => socket?.destroyed).toBe(true);
});
