import type { KubeObject, WatchEventType, WatchServerMessage, WatchStatusState, WatchSubMessage } from '@kubus/shared';
import { wsUrl } from '../http.js';

export interface WatchHandlers {
  onSnapshot(items: KubeObject[]): void;
  onEvents(events: Array<{ type: WatchEventType; object: KubeObject }>): void;
  onStatus(state: WatchStatusState, message?: string): void;
}

export type BroadcastHandler = (msg: Extract<WatchServerMessage, { op: 'drain-progress' | 'pf-update' | 'contexts-changed' }>) => void;

type SubParams = Omit<WatchSubMessage, 'op' | 'id'>;

interface WireSub {
  id: string;
  key: string;
  params: SubParams;
  handlers: Set<WatchHandlers>;
  /** Current objects by uid, maintained from snapshot + events; replayed to new subscribers. */
  cache?: Map<string, KubeObject>;
  lastStatus?: { state: WatchStatusState; message?: string };
  pending: Array<{ type: WatchEventType; object: KubeObject }>;
  flushTimer?: number;
  /** Set while the last subscriber is gone; the wire sub is kept warm until it fires. */
  lingerTimer?: number;
}

const FLUSH_MS = 100;
// Keep watches alive briefly after the last subscriber leaves so tab switches
// and remounts reattach to live data instead of waiting on a fresh snapshot.
const LINGER_MS = 30_000;

function subKey(params: SubParams): string {
  return `${params.ctx}|${params.group}/${params.version}/${params.plural}|${params.namespace ?? ''}`;
}

/**
 * Single multiplexed socket to /ws/watch shared by the whole app.
 * Subscriptions with identical params share one wire subscription; its
 * snapshot cache is replayed synchronously to late subscribers, and the
 * wire sub lingers for LINGER_MS after the last one detaches.
 * Auto-reconnects with resubscribe-all; batches event deltas per
 * subscription on a 100ms flush to avoid render storms.
 */
class WatchClient {
  private ws?: WebSocket;
  private subs = new Map<string, WireSub>(); // by wire id
  private byKey = new Map<string, WireSub>();
  private broadcastHandlers = new Set<BroadcastHandler>();
  private counter = 0;
  private reconnectDelay = 1000;
  private connecting = false;
  private closedByUser = false;

  constructor() {
    // Don't sit out a long backoff when we can tell connectivity is back.
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  private reconnectNow(): void {
    if (this.subs.size === 0 && this.broadcastHandlers.size === 0) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.reconnectDelay = 1000;
    this.ensureConnected();
  }

  subscribe(params: SubParams, handlers: WatchHandlers): () => void {
    const key = subKey(params);
    let sub = this.byKey.get(key);
    if (!sub) {
      sub = { id: `sub-${++this.counter}`, key, params, handlers: new Set(), pending: [] };
      this.byKey.set(key, sub);
      this.subs.set(sub.id, sub);
      this.ensureConnected();
      if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(sub);
    } else if (sub.lingerTimer !== undefined) {
      window.clearTimeout(sub.lingerTimer);
      sub.lingerTimer = undefined;
    }
    sub.handlers.add(handlers);
    // Replay current state synchronously so remounted lists render instantly.
    if (sub.lastStatus) handlers.onStatus(sub.lastStatus.state, sub.lastStatus.message);
    if (sub.cache) handlers.onSnapshot([...sub.cache.values()]);
    return () => {
      sub.handlers.delete(handlers);
      if (sub.handlers.size === 0 && this.byKey.get(key) === sub) {
        sub.lingerTimer ??= window.setTimeout(() => this.teardown(sub), LINGER_MS);
      }
    };
  }

  private teardown(sub: WireSub): void {
    if (sub.flushTimer !== undefined) window.clearTimeout(sub.flushTimer);
    this.byKey.delete(sub.key);
    this.subs.delete(sub.id);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'unsub', id: sub.id }));
    }
  }

  onBroadcast(handler: BroadcastHandler): () => void {
    this.broadcastHandlers.add(handler);
    this.ensureConnected();
    return () => this.broadcastHandlers.delete(handler);
  }

  private sendSub(sub: WireSub): void {
    this.ws?.send(JSON.stringify({ op: 'sub', id: sub.id, ...sub.params }));
  }

  private ensureConnected(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.connecting) return;
    this.connecting = true;
    this.closedByUser = false;

    const ws = new WebSocket(wsUrl('/ws/watch', {}));
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.reconnectDelay = 1000;
      for (const sub of this.subs.values()) this.sendSub(sub);
    };

    ws.onmessage = (ev) => {
      let msg: WatchServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as WatchServerMessage;
      } catch {
        return;
      }
      switch (msg.op) {
        case 'snapshot': {
          const sub = this.subs.get(msg.id);
          if (!sub) break;
          sub.cache = new Map(msg.items.map((item) => [item.metadata.uid, item]));
          for (const handlers of sub.handlers) handlers.onSnapshot(msg.items);
          break;
        }
        case 'event': {
          this.queueEvents(msg.id, [{ type: msg.type, object: msg.object }]);
          break;
        }
        case 'events': {
          this.queueEvents(msg.id, msg.events);
          break;
        }
        case 'status': {
          const sub = this.subs.get(msg.id);
          if (!sub) break;
          sub.lastStatus = { state: msg.state, message: msg.message };
          for (const handlers of sub.handlers) handlers.onStatus(msg.state, msg.message);
          break;
        }
        case 'drain-progress':
        case 'pf-update':
        case 'contexts-changed': {
          for (const handler of this.broadcastHandlers) handler(msg);
          break;
        }
        case 'context-reset': {
          // The server-side session for this context was torn down or rebuilt:
          // resubscribe so lists attach to the new session instead of silently
          // going stale on the disposed one. The cache is kept so rows stay
          // visible until the fresh snapshot replaces them.
          for (const sub of this.subs.values()) {
            if (sub.params.ctx !== msg.ctx) continue;
            sub.pending = [];
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ op: 'unsub', id: sub.id }));
              this.sendSub(sub);
            }
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      this.connecting = false;
      if (this.closedByUser) return;
      for (const sub of this.subs.values()) {
        sub.lastStatus = { state: 'reconnecting', message: 'connection lost' };
        for (const handlers of sub.handlers) handlers.onStatus('reconnecting', 'connection lost');
      }
      if (this.subs.size > 0 || this.broadcastHandlers.size > 0) {
        window.setTimeout(() => this.ensureConnected(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private queueEvents(id: string, events: Array<{ type: WatchEventType; object: KubeObject }>): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.pending.push(...events);
    sub.flushTimer ??= window.setTimeout(() => {
      sub.flushTimer = undefined;
      const batch = sub.pending;
      sub.pending = [];
      if (!batch.length) return;
      sub.cache ??= new Map();
      for (const ev of batch) {
        if (ev.type === 'DELETED') sub.cache.delete(ev.object.metadata.uid);
        else sub.cache.set(ev.object.metadata.uid, ev.object);
      }
      for (const handlers of sub.handlers) handlers.onEvents(batch);
    }, FLUSH_MS);
  }
}

export const watchClient = new WatchClient();
