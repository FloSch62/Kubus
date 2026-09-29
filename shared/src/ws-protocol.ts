import { z } from 'zod';
import type { HelmOperation, HelmReleaseChange, HelmWatchStatus, KubeObject, PortForwardInfo } from './api-types.js';
export { EXEC_SESSION_CLOSE_REASON } from './api-types.js';

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
  /** Release records changed on a cluster (any writer: Kubus, the helm CLI, a GitOps controller). */
  | { op: 'helm-records-changed'; ctx: string; changes: HelmReleaseChange[] }
  | { op: 'helm-watch-status'; ctx: string; status: HelmWatchStatus }
  | { op: 'pf-update'; forwards: PortForwardInfo[] }
  | { op: 'contexts-changed' }
  | { op: 'discovery-update'; ctx: string }
  /** A context's server-side session was torn down or (re)created — watch subscriptions for it must resubscribe. */
  | { op: 'context-reset'; ctx: string };

// ---- Logs ----

/** Workload kinds whose log sessions follow pods as they come and go. */
export const LOG_FOLLOW_TARGET_KINDS = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Service', 'Job'] as const;
export type LogFollowTargetKind = (typeof LOG_FOLLOW_TARGET_KINDS)[number];

const csvList = z
  .string()
  .optional()
  .transform((value) => (value ?? '').split(',').filter(Boolean));

const optionalCount = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
  });

/** Per-source resume cursors ("pod/container" -> RFC3339). A malformed cursor must not block a fresh stream. */
function parseResumeAt(value: string | undefined): Record<string, string> {
  const cursors: Record<string, string> = {};
  if (!value) return cursors;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, ts] of Object.entries(parsed)) {
        if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) cursors[key] = ts;
      }
    }
  } catch {
    // ignore: stream from the requested tail instead
  }
  return cursors;
}

/**
 * Query parameters of /ws/logs. A session reads either a fixed set of pods
 * (`pods`) or follows a workload (`target` + `targetName`), in which case
 * pods join and leave as the workload rolls, and `exclude` lists the pods
 * the viewer turned off. `containers` restricts every pod to those names;
 * omitted means all containers.
 */
export const logSocketQuerySchema = z
  .object({
    ctx: z.string().min(1),
    namespace: z.string().min(1),
    pods: csvList,
    target: z.enum(LOG_FOLLOW_TARGET_KINDS).optional(),
    targetName: z.string().min(1).optional(),
    exclude: csvList,
    containers: z
      .string()
      .optional()
      .transform((value) => (value === undefined ? undefined : value.split(',').filter(Boolean))),
    /** Legacy single-container selection; '' means all containers. */
    container: z
      .string()
      .optional()
      .transform((value) => value || undefined),
    follow: z
      .string()
      .optional()
      .transform((value) => value !== 'false'),
    previous: z
      .string()
      .optional()
      .transform((value) => value === 'true'),
    tailLines: optionalCount,
    sinceSeconds: optionalCount,
    resumeAt: z.string().optional().transform(parseResumeAt),
  })
  .refine((query) => (query.target ? !!query.targetName : query.pods.length > 0), {
    message: 'pods, or target and targetName, are required',
  });

export type LogSocketQuery = z.output<typeof logSocketQuerySchema>;

/** One pod of a followed workload and the containers it runs. */
export interface LogSourcePod {
  pod: string;
  containers: string[];
}

/**
 * Frames on /ws/logs (server -> client). `pods`, `pod-joined` and
 * `pod-left` describe membership: `pods` lists a followed workload's pods
 * when the session opens, `pod-joined` announces a new one, and `pod-left`
 * retires a pod for good (its containers stopped while it terminated, or it
 * was deleted). `waiting` means a container has not started yet; its stream
 * begins once it does.
 */
export type LogServerMessage =
  | { op: 'line'; pod: string; container: string; ts?: string; line: string }
  | { op: 'pod-status'; pod: string; container: string; state: 'waiting' | 'streaming' | 'ended' | 'error'; message?: string }
  | { op: 'pods'; pods: LogSourcePod[] }
  | ({ op: 'pod-joined' } & LogSourcePod)
  | { op: 'pod-left'; pod: string; reason: 'terminated' | 'deleted' };

// ---- Exec ----

/** Text frames on /ws/exec; binary frames carry raw terminal bytes. */
export const execClientControlSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  /** Freeze output before a live terminal is handed to another renderer. */
  z.object({ op: z.literal('prepare-transfer') }),
  /** Resume output when a prepared handoff is abandoned. */
  z.object({ op: z.literal('cancel-transfer') }),
]);
export type ExecClientControl = z.infer<typeof execClientControlSchema>;

export type ExecServerControl =
  | { op: 'session'; terminalId: string }
  | { op: 'transfer-ready' }
  | { op: 'exit'; code?: number; message?: string };
