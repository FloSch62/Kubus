import { createHash } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** One server/state owner per user-data directory; subsequent launches hand off links. */
export async function claimInstance(userData: string, link: string | undefined, activate: (link?: string) => void): Promise<Server | undefined> {
  const id = createHash('sha256').update(userData).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\kubus-${id}` : path.join(tmpdir(), `kubus-${process.getuid?.() ?? 'user'}-${id}.sock`);
  const forward = () => new Promise<'forwarded' | 'absent' | 'closed'>((resolve, reject) => {
    const socket = createConnection(address);
    socket.setTimeout(2000, () => socket.destroy(new Error('The running Kubus instance did not respond.')));
    socket.on('connect', () => socket.end(`${JSON.stringify({ link })}\n`));
    socket.on('data', () => { socket.destroy(); resolve('forwarded'); });
    socket.on('close', () => resolve('closed'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve('absent');
      else reject(error);
    });
  });
  if (await forward() === 'forwarded') return undefined;
  // Named pipes disappear on exit. Unix sockets need a separate kernel lock so
  // only one owner can remove a stale pathname, including after a crash.
  const tryLock = process.platform === 'win32' ? undefined : (await import('./instance-lock.js')).tryInstanceLock;
  let release: (() => void) | undefined;
  let claimed = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString();
      if (input.length > 16_384) { socket.destroy(); return; }
      if (!input.endsWith('\n')) return;
      try {
        const message = JSON.parse(input) as { link?: unknown };
        activate(typeof message.link === 'string' ? message.link : undefined);
        socket.end('ok');
      } catch { socket.destroy(); }
    });
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
    server.once('error', onError);
    server.listen(address, onListening);
  });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (tryLock && !release) release = tryLock(`${address}.lock`);
      if (!tryLock || release) {
        try {
          await listen();
          if (tryLock) chmodSync(address, 0o600);
          server.once('close', () => release?.());
          claimed = true;
          return server;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        }
      }
      const result = await forward();
      if (result === 'forwarded') return undefined;
      if (release && result === 'absent') {
        // Every Unix claimant holds this lock before binding or unlinking.
        try { unlinkSync(address); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await delay(25);
    }
    throw new Error('The running Kubus instance did not respond.');
  } finally {
    if (!claimed) {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      release?.();
    }
  }
}
