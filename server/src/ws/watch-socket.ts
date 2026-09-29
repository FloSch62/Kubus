import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  groupFromPath,
  pluginCanRead,
  type HelmReleaseChange,
  type HelmWatchStatus,
  type KubeObject,
  type WatchServerMessage,
} from '@kubus/shared';
import { watchClientMessageSchema } from '@kubus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { isSecretGVR, redactSecretData } from '../kube/redact.js';
import type { ResourceWatcher, WatcherDelta } from '../kube/watcher.js';
import type { PluginManager } from '../plugins/manager.js';
import { pluginResourceSchema } from '../plugins/manifest.js';

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
      this.lastEventsJson = JSON.stringify(
        deltas.map((d) => ({ type: d.type, object: this.secrets ? redactSecretData(d.object) : d.object })),
      );
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

export function registerWatchSocket(app: FastifyInstance, ctx: AppContext, plugins: PluginManager): void {
  ctx.clusters.on('contexts-changed', () => broadcastWatchMessage({ op: 'contexts-changed' }));
  ctx.clusters.on('context-reset', (name: string) => broadcastWatchMessage({ op: 'context-reset', ctx: name }));
  ctx.clusters.on('discovery-changed', (name: string) => broadcastWatchMessage({ op: 'discovery-update', ctx: name }));
  ctx.clusters.on('helm-records-changed', (name: string, changes: HelmReleaseChange[]) =>
    broadcastWatchMessage({ op: 'helm-records-changed', ctx: name, changes }),
  );
  ctx.clusters.on('helm-watch-status', (name: string, status: HelmWatchStatus) =>
    broadcastWatchMessage({ op: 'helm-watch-status', ctx: name, status }),
  );
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

    socket.on('message', async (data: Buffer) => {
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
      let release: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
        release?.();
      };
      subscriptions.set(msg.id, { stop });
      const allowed = () => {
        if (stopped) return false;
        if (!msg.pluginId) return true;
        try {
          const bundle = plugins.get(msg.pluginId);
          if (!pluginCanRead(bundle.manifest, group, msg.plural)) throw new Error('Resource access was not declared by this plugin');
          return true;
        } catch (err) {
          send({ op: 'status', id: msg.id, state: 'error', message: err instanceof Error ? err.message : String(err) });
          stop();
          subscriptions.delete(msg.id);
          return false;
        }
      };
      try {
        if (!allowed()) return;
        const handle = ctx.clusters.get(msg.ctx);
        if (msg.pluginId) {
          const p = pluginResourceSchema.parse({
            ctx: msg.ctx,
            group,
            version: msg.version,
            plural: msg.plural,
            namespace: msg.namespace,
            namespaceScope: msg.namespaceScope,
          });
          const kind = await handle.discovery.find(group, p.version, p.plural);
          if (stopped) return;
          if (!kind) throw new Error(`${group || 'core'}/${p.version}/${p.plural} is not installed in this cluster`);
          if (kind.namespaced && p.namespaceScope?.length && (!p.namespace || !p.namespaceScope.includes(p.namespace)))
            throw new Error('Resource is outside the selected namespaces');
          if (p.namespace && !kind.namespaced) throw new Error('This resource is cluster scoped');
        }
        if (!allowed()) return;
        const acquired = handle.watchers.acquire(group, msg.version, msg.plural, msg.namespace || undefined);
        release = acquired.release;
        const watcher = acquired.watcher;
        const shared = sharedJsonFor(watcher, secrets);
        const idJson = JSON.stringify(msg.id);
        await watcher.ready();
        if (!allowed()) return;
        const snap = watcher.snapshot();
        sendRaw(
          `{"op":"snapshot","id":${idJson},"resourceVersion":${JSON.stringify(snap.resourceVersion)},"items":${shared.itemsJson(snap)}}`,
        );
        unsubscribe = watcher.subscribe({
          onDeltas: (deltas) => {
            if (!allowed()) return;
            sendRaw(`{"op":"events","id":${idJson},"events":${shared.eventsJson(deltas)}}`);
          },
          onStatus: (state, message) => {
            if (allowed()) send({ op: 'status', id: msg.id, state, message });
          },
        });
        send({ op: 'status', id: msg.id, state: watcher.currentState() });
      } catch (err) {
        if (stopped) return;
        send({ op: 'status', id: msg.id, state: 'error', message: err instanceof Error ? err.message : String(err) });
        stop();
        subscriptions.delete(msg.id);
      }
    });

    socket.on('close', () => {
      openSockets.delete(socket);
      for (const sub of subscriptions.values()) sub.stop();
      subscriptions.clear();
    });
  });
}
