import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { groupFromPath, type WatchServerMessage } from '@kubus/shared';
import { watchClientMessageSchema } from '@kubus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { isSecretGVR, redactSecretData } from '../kube/redact.js';

// All open watch sockets — broadcast channel for drain/pf/context events.
const openSockets = new Set<WebSocket>();

export function broadcastWatchMessage(msg: WatchServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const socket of openSockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

export function registerWatchSocket(app: FastifyInstance, ctx: AppContext): void {
  ctx.clusters.on('contexts-changed', () => broadcastWatchMessage({ op: 'contexts-changed' }));
  ctx.clusters.on('context-reset', (name: string) => broadcastWatchMessage({ op: 'context-reset', ctx: name }));
  ctx.portForwards.on('update', (forwards) => broadcastWatchMessage({ op: 'pf-update', forwards }));

  app.get('/ws/watch', { websocket: true }, (socket: WebSocket) => {
    openSockets.add(socket);
    const subscriptions = new Map<string, { stop: () => void }>();

    const send = (msg: WatchServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on('message', (data: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const result = watchClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        app.log.warn({ issues: result.error.issues }, 'invalid watch message');
        return;
      }
      const msg = result.data;
      if (msg.op === 'unsub') {
        subscriptions.get(msg.id)?.stop();
        subscriptions.delete(msg.id);
        return;
      }

      // op === 'sub'
      if (subscriptions.has(msg.id)) return;
      const group = groupFromPath(msg.group);
      const secrets = isSecretGVR(group, msg.plural);
      let handle;
      try {
        handle = ctx.clusters.get(msg.ctx);
      } catch (err) {
        send({ op: 'status', id: msg.id, state: 'error', message: err instanceof Error ? err.message : String(err) });
        return;
      }
      const { watcher, release } = handle.watchers.acquire(group, msg.version, msg.plural, msg.namespace || undefined);

      let unsubscribe: (() => void) | undefined;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
        release();
      };
      subscriptions.set(msg.id, { stop });

      watcher
        .ready()
        .then(() => {
          if (stopped) return;
          const snap = watcher.snapshot();
          send({
            op: 'snapshot',
            id: msg.id,
            resourceVersion: snap.resourceVersion,
            items: secrets ? snap.items.map(redactSecretData) : snap.items,
          });
          unsubscribe = watcher.subscribe({
            onDeltas: (deltas) => {
              send({
                op: 'events',
                id: msg.id,
                events: deltas.map((d) => ({ type: d.type, object: secrets ? redactSecretData(d.object) : d.object })),
              });
            },
            onStatus: (state, message) => send({ op: 'status', id: msg.id, state, message }),
          });
          send({ op: 'status', id: msg.id, state: watcher.currentState() });
        })
        .catch((err) => {
          send({ op: 'status', id: msg.id, state: 'error', message: err instanceof Error ? err.message : String(err) });
          stop();
          subscriptions.delete(msg.id);
        });
    });

    socket.on('close', () => {
      openSockets.delete(socket);
      for (const sub of subscriptions.values()) sub.stop();
      subscriptions.clear();
    });
  });
}
