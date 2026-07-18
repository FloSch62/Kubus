import { z } from 'zod';
import type { HelmOperation, KubeObject, PortForwardInfo } from './api-types.js';

/** Messages the client sends on /ws/watch. */
export const watchClientMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('sub'),
    id: z.string().min(1),
    ctx: z.string().min(1),
    group: z.string(), // '' for core
    version: z.string().min(1),
    plural: z.string().min(1),
    namespace: z.string().optional(),
  }),
  z.object({
    op: z.literal('unsub'),
    id: z.string().min(1),
  }),
]);

export type WatchClientMessage = z.infer<typeof watchClientMessageSchema>;
export type WatchSubMessage = Extract<WatchClientMessage, { op: 'sub' }>;

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';
export type WatchStatusState = 'live' | 'reconnecting' | 'error' | 'unavailable';

/** Messages the server sends on /ws/watch. */
export type WatchServerMessage =
  | { op: 'snapshot'; id: string; resourceVersion?: string; items: KubeObject[] }
  | { op: 'event'; id: string; type: WatchEventType; object: KubeObject }
  /** Batched form of `event` — what the server actually sends under load. */
  | { op: 'events'; id: string; events: Array<{ type: WatchEventType; object: KubeObject }> }
  | { op: 'status'; id: string; state: WatchStatusState; message?: string }
  | { op: 'drain-progress'; drainId: string; evicted: number; total: number; current?: string; done?: boolean; error?: string }
  | { op: 'helm-operation'; operation: HelmOperation }
  | { op: 'pf-update'; forwards: PortForwardInfo[] }
  | { op: 'contexts-changed' }
  | { op: 'discovery-update'; ctx: string }
  /** A context's server-side session was torn down or (re)created — watch subscriptions for it must resubscribe. */
  | { op: 'context-reset'; ctx: string };

// ---- Logs ----

/** One log line frame on /ws/logs (server -> client). */
export type LogServerMessage =
  | { op: 'line'; pod: string; container: string; ts?: string; line: string }
  | { op: 'pod-status'; pod: string; container: string; state: 'streaming' | 'ended' | 'error'; message?: string };

// ---- Exec ----

/** Text frames on /ws/exec; binary frames carry raw terminal bytes. */
export const execClientControlSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
]);
export type ExecClientControl = z.infer<typeof execClientControlSchema>;

export type ExecServerControl = { op: 'exit'; code?: number; message?: string };
