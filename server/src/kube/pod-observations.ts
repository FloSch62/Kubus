import { failedPodTerminations, type KubeObject, type PodTermination, type PodTerminationHistory } from '@kubus/shared';
import type { ResourceWatcher } from './watcher.js';

/** Per-connection journal. Retains facts after deletion; no logs, env or secrets. */
export class PodObservations {
  private entries = new Map<string, PodTermination>();
  private startedAt = new Date().toISOString();
  private interrupted = false;
  private evicted = 0;
  private nextPrune = 0;
  private unsubscribe?: () => void;
  private watcher?: ResourceWatcher;
  constructor(private readonly capacity = 10_000, private readonly retentionMs = 24 * 60 * 60 * 1000) {}

  start(watcher: ResourceWatcher): void {
    this.stop();
    this.watcher = watcher;
    this.startedAt = new Date().toISOString();
    this.unsubscribe = watcher.subscribe({
      onDeltas: (deltas) => { for (const delta of deltas) this.observe(delta.object); },
      onStatus: (state) => { if (state !== 'live') this.interrupted = true; },
    });
    void watcher.ready().then(() => {
      if (this.watcher === watcher) for (const pod of watcher.items()) this.observe(pod);
    }).catch(() => { if (this.watcher === watcher) this.interrupted = true; });
  }

  observe(pod: KubeObject, now = Date.now()): void {
    for (const entry of failedPodTerminations(pod, new Date(now).toISOString())) {
      const key = `${entry.uid}/${entry.container}/${entry.finishedAt}`;
      if (!this.entries.has(key)) this.entries.set(key, entry);
    }
    this.prune(now);
  }

  private prune(now: number, force = false): void {
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!); this.evicted++;
    }
    // Pod watches can be busy; do not scan the entire journal on every update.
    // A query always checks expiry exactly before returning retained facts.
    if (!force && now < this.nextPrune) return;
    this.nextPrune = now + 60_000;
    for (const [key, value] of this.entries) {
      if (now - Date.parse(value.observedAt) > this.retentionMs) {
        this.entries.delete(key); this.evicted++;
      }
    }
  }

  snapshot(namespace?: string, now = Date.now()): PodTerminationHistory {
    this.prune(now, true);
    return { startedAt: this.startedAt, state: this.watcher?.currentState() ?? 'unavailable', interrupted: this.interrupted, evicted: this.evicted,
      items: [...this.entries.values()].filter((entry) => !namespace || entry.namespace === namespace)
        .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt)) };
  }

  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.watcher = undefined; }
}
