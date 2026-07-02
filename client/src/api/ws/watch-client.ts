import type { KubeObject, WatchEventType, WatchServerMessage, WatchStatusState, WatchSubMessage } from '@kubus/shared';
import { wsUrl } from '../http.js';

export interface WatchHandlers {
  onSnapshot(items: KubeObject[]): void;
  onEvents(events: Array<{ type: WatchEventType; object: KubeObject }>): void;
  onStatus(state: WatchStatusState, message?: string): void;
}

export type BroadcastHandler = (msg: Extract<WatchServerMessage, { op: 'drain-progress' | 'pf-update' | 'contexts-changed' }>) => void;

interface Subscription {
  params: Omit<WatchSubMessage, 'op' | 'id'>;
  handlers: WatchHandlers;
  pending: Array<{ type: WatchEventType; object: KubeObject }>;
  flushTimer?: number;
}

const FLUSH_MS = 100;

/**
 * Single multiplexed socket to /ws/watch shared by the whole app.
 * Auto-reconnects with resubscribe-all; batches event deltas per
 * subscription on a 100ms flush to avoid render storms.
 */
class WatchClient {
  private ws?: WebSocket;
  private subs = new Map<string, Subscription>();
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

  subscribe(params: Subscription['params'], handlers: WatchHandlers): () => void {
    const id = `sub-${++this.counter}`;
    const sub: Subscription = { params, handlers, pending: [] };
    this.subs.set(id, sub);
    this.ensureConnected();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSub(id, sub);
    }
    return () => {
      const existing = this.subs.get(id);
      if (existing?.flushTimer) window.clearTimeout(existing.flushTimer);
      this.subs.delete(id);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'unsub', id }));
      }
    };
  }

  onBroadcast(handler: BroadcastHandler): () => void {
    this.broadcastHandlers.add(handler);
    this.ensureConnected();
    return () => this.broadcastHandlers.delete(handler);
  }

  private sendSub(id: string, sub: Subscription): void {
    this.ws?.send(JSON.stringify({ op: 'sub', id, ...sub.params }));
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
      for (const [id, sub] of this.subs) this.sendSub(id, sub);
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
          this.subs.get(msg.id)?.handlers.onSnapshot(msg.items);
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
          this.subs.get(msg.id)?.handlers.onStatus(msg.state, msg.message);
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
          // going stale on the disposed one.
          for (const [id, sub] of this.subs) {
            if (sub.params.ctx !== msg.ctx) continue;
            sub.pending = [];
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ op: 'unsub', id }));
              this.sendSub(id, sub);
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
        sub.handlers.onStatus('reconnecting', 'connection lost');
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
      if (batch.length) sub.handlers.onEvents(batch);
    }, FLUSH_MS);
  }
}

export const watchClient = new WatchClient();
