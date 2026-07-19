import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { groupFromPath, type KubeObject, type WatchServerMessage } from '@kubus/shared';
import { watchClientMessageSchema } from '@kubus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { isSecretGVR, redactSecretData } from '../kube/redact.js';
import type { ResourceWatcher, WatcherDelta } from '../kube/watcher.js';

/**
 * Per-watcher memo of serialized payload bodies, so redaction and
 * JSON.stringify happen once per delta batch (or snapshot) instead of once
 * per subscribed client — subscribers only differ in the envelope `id`.
 */
class SharedWatchJson {
  private lastDeltas?: WatcherDelta[];
  private lastEventsJson = '';
  private snapshotRv?: string;
  private snapshotJson = '';

  constructor(private secrets: boolean) {}

  /** emitDeltas hands every subscriber the same array, synchronously. */
  eventsJson(deltas: WatcherDelta[]): string {
    if (this.lastDeltas !== deltas) {
      this.lastDeltas = deltas;
      this.lastEventsJson = JSON.stringify(deltas.map((d) => ({ type: d.type, object: this.secrets ? redactSecretData(d.object) : d.object })));
    }
    return this.lastEventsJson;
  }

  /** Snapshot items keyed by resourceVersion; an empty rv is never reused. */
  itemsJson(snap: { items: KubeObject[]; resourceVersion: string }): string {
    if (!snap.resourceVersion || this.snapshotRv !== snap.resourceVersion) {
      this.snapshotRv = snap.resourceVersion || undefined;
      this.snapshotJson = JSON.stringify(this.secrets ? snap.items.map(redactSecretData) : snap.items);
    }
    return this.snapshotJson;
  }
}

// Keyed by watcher identity so the memo dies with the watcher. The secrets
// flag is a property of the watcher's GVR, so first-caller-wins is safe.
const sharedJsonByWatcher = new WeakMap<ResourceWatcher, SharedWatchJson>();

function sharedJsonFor(watcher: ResourceWatcher, secrets: boolean): SharedWatchJson {
  let shared = sharedJsonByWatcher.get(watcher);
  if (!shared) {
    shared = new SharedWatchJson(secrets);
    sharedJsonByWatcher.set(watcher, shared);
  }
  return shared;
}

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
  ctx.clusters.on('discovery-changed', (name: string) => broadcastWatchMessage({ op: 'discovery-update', ctx: name }));
  ctx.portForwards.on('update', (forwards) => broadcastWatchMessage({ op: 'pf-update', forwards }));

  app.get('/ws/watch', { websocket: true }, (socket: WebSocket) => {
    openSockets.add(socket);
    const subscriptions = new Map<string, { stop: () => void }>();

    const send = (msg: WatchServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const sendRaw = (payload: string) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
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
      const shared = sharedJsonFor(watcher, secrets);
      const idJson = JSON.stringify(msg.id);

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
          sendRaw(`{"op":"snapshot","id":${idJson},"resourceVersion":${JSON.stringify(snap.resourceVersion)},"items":${shared.itemsJson(snap)}}`);
          unsubscribe = watcher.subscribe({
            onDeltas: (deltas) => {
              sendRaw(`{"op":"events","id":${idJson},"events":${shared.eventsJson(deltas)}}`);
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
