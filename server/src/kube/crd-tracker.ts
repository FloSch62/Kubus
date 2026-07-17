import type { FastifyBaseLogger } from 'fastify';
import type { RawClient } from './raw-client.js';

const POLL_MS = 10_000;

interface PartialMetadataList {
  items?: Array<{ metadata?: { name?: string; generation?: number } }>;
}

/**
 * Tracks the cluster's CRD set so new kinds (installed by helm charts,
 * operators, or kubectl) surface in the UI without a reload. A real watch
 * would pin every CRD schema in memory; a 10s metadata-only fingerprint poll
 * is invisible. Helm write actions call checkNow() for instant updates.
 */
export class CrdTracker {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private fingerprint?: string;
  private checking = false;

  constructor(
    private raw: RawClient,
    private log: FastifyBaseLogger,
    private onChange: () => void,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.check();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Immediate re-check, e.g. right after a helm install/upgrade/uninstall. */
  checkNow(): void {
    if (this.stopped) return;
    void this.check();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), POLL_MS);
    this.timer.unref();
  }

  private async check(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const list = await this.raw.json<PartialMetadataList>('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?resourceVersion=0', {
        headers: { accept: 'application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io' },
      });
      const fp = (list.items ?? [])
        .map((i) => `${i.metadata?.name ?? ''}@${i.metadata?.generation ?? 0}`)
        .sort()
        .join(',');
      if (this.fingerprint !== undefined && fp !== this.fingerprint) {
        this.log.debug('crd set changed — refreshing discovery');
        this.onChange();
      }
      this.fingerprint = fp;
    } catch {
      // RBAC denied / API unavailable — keep trying quietly, discovery falls
      // back to its TTL.
    } finally {
      this.checking = false;
      this.schedule();
    }
  }
}
