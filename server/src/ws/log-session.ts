import { Writable } from 'node:stream';
import { LOG_SOCKET_COMPLETE_CODE, LOG_SOCKET_NO_STREAMS_CODE, type KubeObject, type LogServerMessage } from '@kubus/shared';
import type { LogSocketQuery } from '@kubus/shared/ws-protocol';
import { podContainers } from '../kube/actions.js';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { resourcePath } from '../kube/raw-client.js';
import { LOG_TARGET_RESOURCES, resolveTargetPods, targetPodMatcher, targetWithoutPods, type TargetPodMatcher } from '../kube/target-pods.js';
import type { WatcherDelta } from '../kube/watcher.js';

type StreamResult = 'ended' | 'error';

/** A target the session cannot follow; retrying would not help. */
class TargetError extends Error {
  constructor(
    message: string,
    readonly closeReason: string,
  ) {
    super(message);
  }
}

interface StreamOutcome {
  result: StreamResult;
  message?: string;
  code?: number;
}

/**
 * A stream that ended while the pod watcher still reports its container run
 * as alive waits this long for the watcher to catch up (container exit, pod
 * termination) before the session asks the client to reconnect.
 */
const SETTLE_GRACE_MS = 3_000;
/** Longest wait for the shared pods watcher before falling back to one-off reads. */
const FEED_READY_TIMEOUT_MS = 10_000;
/**
 * The Job controller marks a Job Complete or Failed a moment after its last
 * pod finished, so a followed Job whose pods are all done asks again on this
 * beat, for about a minute. A new pod starts the count over.
 */
const JOB_RECHECK_MS = 2_000;
const JOB_RECHECKS = 30;

const RFC3339_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/;

/**
 * A log timestamp as nanoseconds since the epoch. RFC 3339 timestamps with
 * trimmed fractions do not sort as strings, and a Date keeps milliseconds.
 */
export function logTimestampNanos(ts: string): bigint | undefined {
  const match = RFC3339_RE.exec(ts);
  if (!match) return undefined;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) return undefined;
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

interface ContainerStatusLike {
  name?: string;
  containerID?: string;
  restartCount?: number;
  state?: { running?: unknown; terminated?: { containerID?: string }; waiting?: { reason?: string } };
  lastState?: { terminated?: { containerID?: string } };
}

interface PodStatusLike {
  phase?: string;
  conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  containerStatuses?: ContainerStatusLike[];
  initContainerStatuses?: ContainerStatusLike[];
}

export interface ContainerRun {
  /** Identity of the newest run of the container that has logs. */
  id?: string;
  running: boolean;
  /** Why the container is not running (ContainerCreating, CrashLoopBackOff, …). */
  waiting?: string;
}

/** Where a container stands: which run the kubelet would serve logs for, and whether it is still going. */
export function containerRun(pod: KubeObject | undefined, container: string): ContainerRun {
  const status = pod?.status as PodStatusLike | undefined;
  const entry = [...(status?.containerStatuses ?? []), ...(status?.initContainerStatuses ?? [])].find((s) => s.name === container);
  if (!entry) {
    const scheduled = status?.conditions?.find((condition) => condition.type === 'PodScheduled');
    return { running: false, waiting: scheduled?.status === 'False' ? (scheduled.reason ?? 'Pending') : 'Pending' };
  }
  const restarts = entry.restartCount ?? 0;
  if (entry.state?.running) return { id: entry.containerID || `#${restarts}`, running: true };
  if (entry.state?.terminated) return { id: entry.state.terminated.containerID || entry.containerID || `#${restarts}`, running: false };
  const waiting = entry.state?.waiting?.reason ?? 'Waiting';
  const last = entry.lastState?.terminated;
  return last ? { id: last.containerID || `#${Math.max(0, restarts - 1)}`, running: false, waiting } : { running: false, waiting };
}

function podFinished(pod: KubeObject | undefined): boolean {
  const phase = (pod?.status as PodStatusLike | undefined)?.phase;
  return phase === 'Succeeded' || phase === 'Failed';
}

interface PodFeed {
  /** Backed by a pods watcher: pod updates arrive as deltas. */
  live: boolean;
  pods(): KubeObject[];
  get(name: string): KubeObject | undefined;
  subscribe(listener: (deltas: WatcherDelta[]) => void): () => void;
  release(): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The pods watcher the cluster already keeps (cluster-wide, pinned while the
 * cluster is connected), or a namespaced one for users who may only list
 * pods in this namespace. Undefined when neither becomes ready.
 */
async function watchedPodFeed(handle: ClusterHandle, namespace: string): Promise<PodFeed | undefined> {
  for (const scope of [undefined, namespace]) {
    let lease: ReturnType<ClusterHandle['watchers']['acquire']> | undefined;
    try {
      lease = handle.watchers.acquire('', 'v1', 'pods', scope);
      await withTimeout(lease.watcher.ready(), FEED_READY_TIMEOUT_MS);
      if (lease.watcher.currentState() === 'unavailable') throw new Error('pods API unavailable');
    } catch {
      lease?.release();
      continue;
    }
    const { watcher, release } = lease;
    const inNamespace = (pod: KubeObject) => pod.metadata.namespace === namespace;
    return {
      live: true,
      pods: () => watcher.items().filter(inNamespace),
      get: (name) => watcher.items().find((pod) => inNamespace(pod) && pod.metadata.name === name),
      subscribe: (listener) =>
        watcher.subscribe({
          onDeltas: (deltas) => {
            const mine = deltas.filter((delta) => inNamespace(delta.object));
            if (mine.length) listener(mine);
          },
          onStatus: () => {},
        }),
      release,
    };
  }
  return undefined;
}

function staticPodFeed(pods: Map<string, KubeObject | undefined>): PodFeed {
  return {
    live: false,
    pods: () => [...pods.values()].filter((pod): pod is KubeObject => !!pod),
    get: (name) => pods.get(name),
    subscribe: () => () => {},
    release: () => {},
  };
}

interface PodEntry {
  name: string;
  uid?: string;
  /** Turned off in the viewer: listed, never streamed. */
  excluded: boolean;
  /** Seen with a deletionTimestamp: it is shutting down, not vanishing. */
  terminating: boolean;
  left: boolean;
  sources: Source[];
}

/**
 * - pending: nothing read yet
 * - waiting: the container has not started
 * - streaming: a log request is open
 * - grace: the stream ended but the watcher still reports that run as alive
 * - ended: read to the end of the container's latest run; a restart resumes it
 */
type SourceState = 'pending' | 'waiting' | 'streaming' | 'grace' | 'ended';

interface Source {
  entry: PodEntry;
  container: string;
  key: string;
  state: SourceState;
  /** Container run the current or last stream read. */
  run?: string;
  waiting?: string;
  lastTs?: string;
  lastOutcome?: StreamOutcome;
  abort?: AbortController;
  grace?: NodeJS.Timeout;
}

export interface LogSessionIo {
  send(message: LogServerMessage): void;
  close(code: number, reason: string): void;
}

function errorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * One /ws/logs session: fans in the log streams of a fixed set of pods, or of
 * every pod of a workload. With a pods watcher available, follow sessions
 * track pod lifecycles: containers that have not started wait instead of
 * failing, pods that terminate or get deleted retire their streams, and a
 * followed workload's new pods join as they appear.
 */
export class LogSession {
  private readonly pods = new Map<string, PodEntry>();
  private readonly containers?: ReadonlySet<string>;
  private readonly exclude: ReadonlySet<string>;
  private feed?: PodFeed;
  private unsubscribe?: () => void;
  private matcher?: TargetPodMatcher;
  private handle?: ClusterHandle;
  private queue: Promise<void> = Promise.resolve();
  private ready = false;
  private disposed = false;
  private finishing = false;
  private jobTimer?: NodeJS.Timeout;
  private jobChecks = 0;
  private streamsOpened = 0;
  private streamsFailed = 0;
  private podsLeft = 0;

  constructor(
    private readonly clusterHandle: () => ClusterHandle,
    private readonly query: LogSocketQuery,
    private readonly io: LogSessionIo,
  ) {
    const selected = query.containers ?? (query.container ? [query.container] : undefined);
    this.containers = selected ? new Set(selected) : undefined;
    this.exclude = new Set(query.exclude);
  }

  async start(): Promise<void> {
    const { namespace, target, targetName } = this.query;
    try {
      const handle = this.clusterHandle();
      this.handle = handle;
      this.feed = await watchedPodFeed(handle, namespace);
      if (this.disposed) return this.dispose();
      if (target && targetName) {
        const { group, version, plural } = LOG_TARGET_RESOURCES[target];
        const targetObj = await handle.raw.json<KubeObject>(resourcePath(group, version, plural, { namespace, name: targetName })).catch((err: unknown) => {
          if (errorCode(err) === 404) throw new TargetError(`${target} ${namespace}/${targetName} not found`, 'log target not found');
          throw err;
        });
        const noPods = targetWithoutPods(targetObj, target);
        if (noPods) throw new TargetError(`No pods found for ${target} ${namespace}/${targetName}: ${noPods}`, 'log target has no pods');
        this.matcher = targetPodMatcher(handle, targetObj, target, namespace);
        if (!this.feed) {
          const pods = await resolveTargetPods(handle, targetObj, target, namespace);
          this.feed = staticPodFeed(new Map(pods.map((pod) => [pod.metadata.name, pod])));
        }
      }
      if (this.disposed) return;
      // Queue the initial load first: deltas that arrive meanwhile run after
      // it and see the pods it added.
      const initial = this.enqueue(() => this.loadInitial());
      if (this.query.follow && this.feed?.live) {
        this.unsubscribe = this.feed.subscribe((deltas) => void this.enqueue(() => this.onDeltas(deltas)));
      }
      await initial;
    } catch (err) {
      this.io.send({ op: 'pod-status', pod: '', container: '', state: 'error', message: err instanceof Error ? err.message : String(err) });
      if (err instanceof TargetError) this.io.close(LOG_SOCKET_NO_STREAMS_CODE, err.closeReason);
      else this.io.close(1011, 'log session failed');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.jobTimer);
    this.feed?.release();
    for (const entry of this.pods.values()) {
      for (const source of entry.sources) {
        clearTimeout(source.grace);
        source.abort?.abort();
      }
    }
  }

  private get live(): boolean {
    return this.query.follow && !!this.feed?.live;
  }

  private enqueue(task: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(() => (this.disposed ? undefined : task()))
      .catch((err: unknown) => {
        if (this.disposed) return;
        this.io.send({ op: 'pod-status', pod: '', container: '', state: 'error', message: err instanceof Error ? err.message : String(err) });
        this.io.close(1011, 'log session failed');
      });
    return this.queue;
  }

  private async loadInitial(): Promise<void> {
    const feed = this.feed;
    if (this.matcher) {
      const candidates = feed?.pods() ?? [];
      const matched: KubeObject[] = [];
      for (const pod of candidates) {
        if (!feed?.live || (await this.matcher(pod))) matched.push(pod);
      }
      matched.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
      if (this.disposed) return;
      this.io.send({ op: 'pods', pods: matched.map((pod) => ({ pod: pod.metadata.name, containers: podContainers(pod) })) });
      for (const pod of matched) this.addPod(pod.metadata.name, pod, false);
    } else {
      const fetched = new Map<string, KubeObject | undefined>();
      const missing = new Set<string>();
      await Promise.all(
        this.query.pods.map(async (name) => {
          const cached = feed?.live ? feed.get(name) : undefined;
          if (cached) {
            fetched.set(name, cached);
            return;
          }
          // Read the pod even for a multi-container selection so names that
          // do not exist on this particular replica are ignored.
          const read = await this.handle!.core.readNamespacedPod({ name, namespace: this.query.namespace }).catch((err: unknown) => {
            if (errorCode(err) === 404) missing.add(name);
            return undefined;
          });
          fetched.set(name, read as KubeObject | undefined);
        }),
      );
      if (this.disposed) return;
      if (!feed?.live) this.feed = staticPodFeed(fetched);
      for (const name of this.query.pods) {
        if (feed?.live && missing.has(name)) {
          const entry: PodEntry = { name, excluded: false, terminating: false, left: false, sources: [] };
          this.pods.set(name, entry);
          this.retire(entry, 'deleted');
          continue;
        }
        this.addPod(name, fetched.get(name), false);
      }
    }
    this.ready = true;
    this.checkDone();
  }

  private addPod(name: string, pod: KubeObject | undefined, announce: boolean): void {
    const all = pod?.spec ? podContainers(pod) : this.containers ? [...this.containers] : [''];
    const entry: PodEntry = {
      name,
      uid: pod?.metadata?.uid,
      excluded: this.exclude.has(name),
      terminating: !!pod?.metadata?.deletionTimestamp,
      left: false,
      sources: [],
    };
    this.pods.set(name, entry);
    if (announce) {
      this.io.send({ op: 'pod-joined', pod: name, containers: pod ? podContainers(pod) : [] });
      this.jobChecks = 0;
    }
    if (entry.excluded) return;
    const selected = this.containers ? all.filter((container) => this.containers!.has(container)) : all;
    if (!selected.length) {
      this.io.send({ op: 'pod-status', pod: name, container: '', state: 'error', message: 'No selected containers are available in this pod' });
      return;
    }
    for (const container of selected) {
      const source: Source = { entry, container, key: `${name}/${container}`, state: 'pending' };
      entry.sources.push(source);
      this.advance(source, pod);
    }
  }

  /** Decide what a source that is not streaming should do, given the pod's latest state. */
  private advance(source: Source, pod: KubeObject | undefined): void {
    if (this.disposed || source.entry.left || source.state === 'streaming') return;
    if (!this.live) {
      // One-off reads, and sessions without a pods watcher, read whatever the API serves now.
      if (source.state === 'pending') this.startStream(source, undefined);
      return;
    }
    const run = containerRun(pod, source.container);
    if (run.id && run.id !== source.run) {
      this.startStream(source, run.id);
      return;
    }
    if (pod?.metadata.deletionTimestamp) {
      this.leaveGrace(source);
      source.state = 'ended';
      return;
    }
    if (run.waiting) {
      this.leaveGrace(source);
      if (source.state !== 'waiting' || source.waiting !== run.waiting) {
        source.state = 'waiting';
        source.waiting = run.waiting;
        this.io.send({ op: 'pod-status', pod: source.entry.name, container: source.container, state: 'waiting', message: run.waiting });
      }
      return;
    }
    if (run.running) {
      // Same run we already read to its end, still reported alive: the
      // watcher lags behind the container's exit, or the upstream broke.
      if (source.state !== 'grace') {
        source.state = 'grace';
        source.grace = setTimeout(() => void this.enqueue(() => this.graceExpired(source)), SETTLE_GRACE_MS);
      }
      return;
    }
    this.leaveGrace(source);
    source.state = 'ended';
  }

  private leaveGrace(source: Source): void {
    clearTimeout(source.grace);
    source.grace = undefined;
  }

  private graceExpired(source: Source): void {
    source.grace = undefined;
    if (source.state !== 'grace' || source.entry.left) return;
    const pod = this.feed?.get(source.entry.name);
    if (!pod || (source.entry.uid && pod.metadata.uid !== source.entry.uid)) {
      this.retire(source.entry, source.entry.terminating ? 'terminated' : 'deleted');
      return;
    }
    const run = containerRun(pod, source.container);
    if (run.running && run.id === source.run && !pod.metadata.deletionTimestamp) {
      if (source.lastOutcome?.result === 'error') this.sendStreamError(source);
      // Hand the retry to the client, which resumes every source from its cursor.
      this.io.close(1011, source.lastOutcome?.result === 'error' ? 'upstream log stream failed' : 'upstream log stream ended');
      return;
    }
    source.state = 'ended';
    this.advance(source, pod);
    this.checkDone();
  }

  private startStream(source: Source, run: string | undefined): void {
    this.leaveGrace(source);
    source.state = 'streaming';
    source.run = run;
    source.waiting = undefined;
    this.streamsOpened++;
    void this.streamOne(source).then((outcome) => this.enqueue(() => this.streamFinished(source, outcome)));
  }

  private streamFinished(source: Source, outcome: StreamOutcome): void {
    // Release the upstream request, which may linger after an early unpipe.
    source.abort?.abort();
    source.abort = undefined;
    source.lastOutcome = outcome;
    if (outcome.result === 'error') this.streamsFailed++;
    const entry = source.entry;
    if (entry.left) return;
    source.state = 'ended';

    if (!this.query.follow) {
      if (outcome.result === 'error') this.sendStreamError(source);
      this.checkDone();
      return;
    }

    if (!this.feed?.live) {
      if (outcome.result === 'error') this.sendStreamError(source);
      const run = containerRun(this.feed?.get(entry.name), source.container);
      const terminated = !!run.id && !run.running && !run.waiting;
      // A live container's stream should not end: let the client reconnect and resume.
      if (!terminated) {
        this.io.close(1011, outcome.result === 'error' ? 'upstream log stream failed' : 'upstream log stream ended');
        return;
      }
      this.checkDone();
      return;
    }

    const pod = this.feed.get(entry.name);
    if (!pod || (entry.uid && pod.metadata.uid !== entry.uid) || outcome.code === 404) {
      this.retire(entry, entry.terminating ? 'terminated' : 'deleted');
      return;
    }
    if (pod.metadata.deletionTimestamp) {
      // Shutting down: its last lines are in, errors from the closing stream are noise.
      this.retireIfIdle(entry);
      return;
    }
    this.advance(source, pod);
    // A failed read of a finished run is worth showing; one that broke
    // because the container went away or restarted is not.
    if (outcome.result === 'error' && source.state === 'ended') this.sendStreamError(source);
    this.checkDone();
  }

  private sendStreamError(source: Source): void {
    this.io.send({
      op: 'pod-status',
      pod: source.entry.name,
      container: source.container,
      state: 'error',
      message: source.lastOutcome?.message ?? 'stream error',
    });
  }

  private retire(entry: PodEntry, reason: 'terminated' | 'deleted'): void {
    if (entry.left) return;
    entry.left = true;
    this.podsLeft++;
    for (const source of entry.sources) {
      this.leaveGrace(source);
      source.abort?.abort();
      source.state = 'ended';
    }
    this.io.send({ op: 'pod-left', pod: entry.name, reason });
    this.checkDone();
  }

  /** A terminating pod leaves once none of its containers is still streaming its last lines. */
  private retireIfIdle(entry: PodEntry): void {
    if (entry.sources.some((source) => source.state === 'streaming')) return;
    this.retire(entry, 'terminated');
  }

  private async onDeltas(deltas: WatcherDelta[]): Promise<void> {
    for (const { type, object } of deltas) {
      if (this.disposed) return;
      const name = object.metadata.name;
      let entry = this.pods.get(name);
      if (entry && entry.uid && object.metadata.uid !== entry.uid) {
        // A new pod under an old name (StatefulSet replacement): the old one is gone.
        if (type === 'DELETED') continue;
        this.retire(entry, entry.terminating ? 'terminated' : 'deleted');
        this.pods.delete(name);
        entry = undefined;
      }
      if (type === 'DELETED') {
        // Graceful deletions carry their deletionTimestamp into the final event.
        if (entry) this.retire(entry, entry.terminating || object.metadata.deletionTimestamp ? 'terminated' : 'deleted');
        continue;
      }
      if (entry) {
        if (!entry.left) this.podUpdated(entry, object);
        continue;
      }
      if (!this.matcher || object.metadata.deletionTimestamp) continue;
      if (!(await this.matcher(object)) || this.disposed || this.pods.has(name)) continue;
      this.addPod(name, object, true);
    }
  }

  private podUpdated(entry: PodEntry, pod: KubeObject): void {
    if (pod.metadata.deletionTimestamp) {
      entry.terminating = true;
      for (const source of entry.sources) {
        if (source.state === 'streaming') continue;
        this.leaveGrace(source);
        source.state = 'ended';
      }
      this.retireIfIdle(entry);
      return;
    }
    for (const source of entry.sources) {
      if (source.state !== 'streaming') this.advance(source, pod);
    }
    this.checkDone();
  }

  /** Close the session once nothing can produce more lines. */
  private checkDone(): void {
    if (!this.ready || this.disposed || this.finishing) return;
    const active = [...this.pods.values()].filter((entry) => !entry.left);
    const sources = active.flatMap((entry) => entry.sources);
    if (sources.some((source) => source.state === 'pending' || source.state === 'streaming' || source.state === 'grace')) return;
    if (this.live) {
      if (sources.some((source) => source.state === 'waiting')) return;
      // Containers of a running pod can restart and log again.
      if (!active.every((entry) => podFinished(this.feed?.get(entry.name)))) return;
      if (this.matcher) {
        if (this.query.target === 'Job') void this.enqueue(() => this.finishIfJobDone());
        return;
      }
    }
    this.finish();
  }

  private async finishIfJobDone(): Promise<void> {
    if (this.finishing || this.jobTimer) return;
    if (await this.jobDone()) {
      this.finish();
      return;
    }
    if (this.disposed || this.jobChecks >= JOB_RECHECKS) return;
    this.jobChecks++;
    this.jobTimer = setTimeout(() => {
      this.jobTimer = undefined;
      // Re-run the whole check: a pod may have joined in the meantime.
      void this.enqueue(() => this.checkDone());
    }, JOB_RECHECK_MS);
  }

  /** The followed Job finished (Complete or Failed), or is gone (TTL after finishing). */
  private async jobDone(): Promise<boolean> {
    const { group, version, plural } = LOG_TARGET_RESOURCES.Job;
    try {
      const job = await this.handle!.raw.json<KubeObject>(
        resourcePath(group, version, plural, { namespace: this.query.namespace, name: this.query.targetName! }),
      );
      const conditions = (job.status as { conditions?: Array<{ type?: string; status?: string }> } | undefined)?.conditions ?? [];
      return conditions.some((condition) => (condition.type === 'Complete' || condition.type === 'Failed') && condition.status === 'True');
    } catch (err) {
      return errorCode(err) === 404;
    }
  }

  private finish(): void {
    if (this.finishing) return;
    this.finishing = true;
    if (this.streamsOpened === 0 && this.podsLeft === 0) {
      this.io.close(LOG_SOCKET_NO_STREAMS_CODE, 'no log streams available');
    } else if (this.streamsOpened > 0 && this.streamsFailed === this.streamsOpened && this.podsLeft === 0) {
      this.io.close(LOG_SOCKET_NO_STREAMS_CODE, 'all log streams failed');
    } else {
      this.io.close(LOG_SOCKET_COMPLETE_CODE, 'log session complete');
    }
  }

  private async streamOne(source: Source): Promise<StreamOutcome> {
    const pod = source.entry.name;
    const containerName = source.container;
    const { follow, previous, tailLines, sinceSeconds, namespace } = this.query;
    let buffer = '';
    let settled = false;
    let settle!: (outcome: StreamOutcome) => void;
    const completion = new Promise<StreamOutcome>((resolve) => {
      settle = resolve;
    });
    const complete = (outcome: StreamOutcome) => {
      if (settled) return;
      settled = true;
      settle(outcome);
    };
    // After a container restart, read the new run from where the last one stopped.
    const sinceTime = source.lastTs ?? this.query.resumeAt[source.key];
    // The API server passes sinceTime to the kubelet in whole seconds, so the
    // kubelet replays the start of that second: drop lines older than the
    // cursor. Lines at exactly the cursor pass; the client counts those off.
    let replayFloor = sinceTime ? logTimestampNanos(sinceTime) : undefined;
    const forwardLine = (raw: string) => {
      if (!raw) return;
      // With timestamps: "2026-01-02T03:04:05.000000000Z the line"
      const space = raw.indexOf(' ');
      const ts = space > 0 ? raw.slice(0, space) : undefined;
      const line = space > 0 ? raw.slice(space + 1) : raw;
      if (replayFloor !== undefined && ts) {
        const at = logTimestampNanos(ts);
        if (at !== undefined && at < replayFloor) return;
        // One container's lines arrive in order: nothing older follows.
        replayFloor = undefined;
      }
      if (ts) source.lastTs = ts;
      this.io.send({ op: 'line', pod, container: containerName, ts, line });
    };
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          forwardLine(raw);
        }
        cb();
      },
      final: (cb) => {
        forwardLine(buffer);
        if (!this.disposed) this.io.send({ op: 'pod-status', pod, container: containerName, state: 'ended' });
        complete({ result: 'ended' });
        cb();
      },
      destroy(_err, cb) {
        complete({ result: 'ended' });
        cb();
      },
    });
    sink.on('unpipe', () => {
      queueMicrotask(() => {
        if (settled || this.disposed) return;
        complete({ result: 'error', message: 'Upstream log stream closed before completion' });
      });
    });

    const abort = new AbortController();
    source.abort = abort;
    try {
      const query = new URLSearchParams({
        container: containerName,
        follow: String(follow),
        previous: String(previous),
        timestamps: 'true',
      });
      if (!sinceTime && tailLines !== undefined) query.set('tailLines', String(tailLines));
      if (!sinceTime && sinceSeconds !== undefined) query.set('sinceSeconds', String(sinceSeconds));
      if (sinceTime) query.set('sinceTime', sinceTime);

      this.io.send({ op: 'pod-status', pod, container: containerName, state: 'streaming' });
      const response = await this.handle!.raw.stream(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query.toString()}`,
        { signal: abort.signal, deadlineMs: false },
      );
      const upstream = response.body;
      if (!upstream) throw new Error('Kubernetes log response had no body');
      upstream.on('error', (err: unknown) => {
        if (!abort.signal.aborted && !this.disposed) {
          complete({ result: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        sink.destroy();
      });
      upstream.pipe(sink);
      if (this.disposed || source.entry.left) abort.abort();
      return await completion;
    } catch (err) {
      sink.destroy();
      if (abort.signal.aborted) return { result: 'ended' };
      return { result: 'error', message: err instanceof Error ? err.message : String(err), code: errorCode(err) };
    }
  }
}
