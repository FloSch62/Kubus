import type { FastifyBaseLogger } from 'fastify';
import type { HelmReleaseChange, HelmWatchStatus, WatchStatusState } from '@kubus/shared';
import type { RawClient } from '../kube/raw-client.js';
import { ResourceWatcher, type ResourceWatcherOptions, type WatcherDelta } from '../kube/watcher.js';

const RELEASE_RECORD_NAME_RE = /^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/;
/** Trailing coalesce window: one upgrade patches the same record several times in a row. */
const COALESCE_MS = 200;

/**
 * Release records are Secrets (default driver) or ConfigMaps labelled
 * owner=helm. Their payloads are large and can embed credentials, so the
 * watch asks for PartialObjectMetadata: only names, labels and resource
 * versions travel and nothing but metadata is cached. A user without
 * cluster-wide access (403) falls back to polling instead of retrying forever.
 */
export const HELM_RECORD_WATCH_OPTIONS: ResourceWatcherOptions = {
  query: { labelSelector: 'owner=helm' },
  listHeaders: { accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1' },
  watchHeaders: { accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' },
  unavailableStatusCodes: [403, 404],
};

export interface HelmRecordWatcherHandlers {
  onChanges(changes: HelmReleaseChange[]): void;
  onStatus(status: HelmWatchStatus): void;
}

interface DriverState {
  state: WatchStatusState;
  message?: string;
}

/**
 * Change signal for a cluster's Helm releases: one metadata-only watch per
 * storage driver, coalesced into "these releases changed" notifications. The
 * HTTP release endpoints stay the source of truth; this only tells clients
 * when to ask again, so writes by the helm CLI or a GitOps controller show
 * up as fast as Kubus's own.
 */
export class HelmRecordWatcher {
  private readonly watchers: ResourceWatcher[];
  private readonly driverStates = new Map<string, DriverState>();
  private readonly pending = new Map<string, HelmReleaseChange>();
  private flushTimer?: NodeJS.Timeout;
  private unsubscribes: Array<() => void> = [];
  private started = false;
  private current: HelmWatchStatus = { state: 'reconnecting', message: 'not started' };

  constructor(
    raw: RawClient,
    private log: FastifyBaseLogger,
    private handlers: HelmRecordWatcherHandlers,
  ) {
    this.watchers = ['secrets', 'configmaps'].map((plural) => new ResourceWatcher(raw, '', 'v1', plural, undefined, log, HELM_RECORD_WATCH_OPTIONS));
  }

  status(): HelmWatchStatus {
    return { ...this.current };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const watcher of this.watchers) {
      this.driverStates.set(watcher.plural, { state: 'reconnecting' });
      this.unsubscribes.push(
        watcher.subscribe({
          onDeltas: (deltas) => this.onDeltas(deltas),
          onStatus: (state, message) => this.onDriverStatus(watcher.plural, state, message),
        }),
      );
      watcher.start();
    }
    this.publishStatus();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    for (const watcher of this.watchers) watcher.stop();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
  }

  private onDeltas(deltas: WatcherDelta[]): void {
    for (const delta of deltas) {
      const change = releaseChange(delta);
      if (!change) continue;
      // Within a window the newest revision wins (an upgrade supersedes the
      // old record right after creating the new one); the client refetches
      // the release either way.
      const key = `${change.namespace}/${change.name}`;
      const queued = this.pending.get(key);
      if (!queued || change.revision >= queued.revision) this.pending.set(key, change);
    }
    if (this.pending.size && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), COALESCE_MS);
      this.flushTimer.unref();
    }
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (!this.pending.size) return;
    const changes = [...this.pending.values()];
    this.pending.clear();
    try {
      this.handlers.onChanges(changes);
    } catch (err) {
      this.log.warn({ err }, 'helm record change handler failed');
    }
  }

  private onDriverStatus(plural: string, state: WatchStatusState, message?: string): void {
    this.driverStates.set(plural, { state, message });
    this.publishStatus();
  }

  private publishStatus(): void {
    const next = aggregateStatus(this.driverStates);
    if (next.state === this.current.state && next.message === this.current.message) return;
    this.current = next;
    try {
      this.handlers.onStatus({ ...next });
    } catch (err) {
      this.log.warn({ err }, 'helm watch status handler failed');
    }
  }
}

/** Parse a release record delta into the release it belongs to; non-record objects yield nothing. */
export function releaseChange(delta: WatcherDelta): HelmReleaseChange | undefined {
  const match = RELEASE_RECORD_NAME_RE.exec(delta.object.metadata?.name ?? '');
  if (!match) return undefined;
  return {
    namespace: delta.object.metadata.namespace ?? '',
    name: match[1]!,
    revision: Number(match[2]),
    status: delta.object.metadata.labels?.status,
    type: delta.type,
  };
}

/**
 * Secrets are Helm's default driver and configmaps the rare legacy one: the
 * signal is live as soon as either stream is, and only unavailable when both
 * are. A driver that cannot be watched is named in the message so the UI can
 * explain a partial signal.
 */
function aggregateStatus(states: Map<string, DriverState>): HelmWatchStatus {
  const entries = [...states.entries()];
  const unavailable = entries.filter(([, s]) => s.state === 'unavailable');
  if (entries.some(([, s]) => s.state === 'live')) {
    if (!unavailable.length) return { state: 'live' };
    const [plural, detail] = unavailable[0]!;
    return { state: 'live', message: `${plural} records cannot be watched${detail.message ? `: ${detail.message}` : ''}` };
  }
  if (entries.length && unavailable.length === entries.length) {
    return { state: 'unavailable', message: states.get('secrets')?.message ?? unavailable[0]?.[1].message };
  }
  const error = entries.find(([, s]) => s.state === 'error');
  if (error) return { state: 'error', message: error[1].message };
  const reconnecting = states.get('secrets') ?? entries[0]?.[1];
  return { state: 'reconnecting', message: reconnecting?.message };
}
