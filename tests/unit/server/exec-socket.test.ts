import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../server/src/app.js';
import { registerExecSocket } from '../../../server/src/ws/exec-socket.js';

type Handler = (socket: unknown, request: unknown) => unknown;

function routeCollector() {
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, optionsOrHandler: unknown, handler?: unknown) {
      routes.set(path, (handler ?? optionsOrHandler) as Handler);
    },
  } as unknown as FastifyInstance;
  return { routes, app };
}

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;

  send() {}

  ping() {}

  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for exec setup');
}

it.each([
  [undefined, ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l']],
  ['bash', ['bash', '-l']],
  ['sh', ['sh', '-l']],
  ['/bin/zsh', ['/bin/zsh', '-l']],
  ['/opt/tools/custom-shell', ['/opt/tools/custom-shell']],
])('starts configured shell %s with appropriate login semantics', async (shell, expected) => {
  const { app, routes } = routeCollector();
  const commands: string[][] = [];
  const upstream = new FakeSocket();
  const handle = {
    makeExec() {
      return {
        async exec(
          _namespace: string,
          _pod: string,
          _container: string,
          command: string[],
        ) {
          commands.push(command);
          return upstream;
        },
      };
    },
  };
  const ctx = { clusters: { get: () => handle } } as unknown as AppContext;
  registerExecSocket(app, ctx);

  const socket = new FakeSocket();
  routes.get('/ws/exec')?.(socket, {
    query: {
      ctx: 'dev',
      namespace: 'ops',
      pod: 'api-0',
      container: 'app',
      shell,
    },
  });
  await waitFor(() => upstream.listenerCount('close') > 0);

  expect(commands).toEqual([expected]);
  upstream.emit('close');
});
