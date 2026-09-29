import {
  pluralLabel,
  type InventoryProblem,
  type OperatorRollup,
  type OverviewCertificates,
  type OverviewProblemPod,
  type OverviewWarningEvent,
  type OverviewWorkloadIssue,
} from '@kubus/shared';
import type { AttentionItem } from './Attention.js';
import { failingPodBreakdown, issueTone } from './issue-cause.js';

const API_SERVER_WARN_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Scroll the overview block marked `data-anchor` inside the same cluster section into view. */
export function jumpToAnchor(from: HTMLElement, anchor: string): void {
  const section = from.closest('[data-overview-section]') ?? document;
  const target = section.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
  if (!target) return;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

/** "3 Deployments · 2 StatefulSets", largest first. */
function kindBreakdown(issues: OverviewWorkloadIssue[]): string {
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${n === 1 ? kind : pluralLabel(kind)}`)
    .join(' · ');
}

/** "4 Failed · 3 BackOff", top three reasons by events in the window. */
function reasonBreakdown(events: OverviewWarningEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.reason || 'Warning', (counts.get(e.reason || 'Warning') ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(' · ');
}

function certificateCount(certificates: OverviewCertificates | undefined, now: number): { count: number; expired: boolean; detail?: string } {
  if (!certificates) return { count: 0, expired: false };
  const apiServerSoon = !!certificates.apiServerNotAfter && Date.parse(certificates.apiServerNotAfter) - now < API_SERVER_WARN_MS;
  const count = certificates.expiring.length + (apiServerSoon ? 1 : 0);
  const soonest = [...certificates.expiring.map((c) => ({ name: c.name, at: Date.parse(c.notAfter) })), ...(apiServerSoon ? [{ name: 'API server', at: Date.parse(certificates.apiServerNotAfter!) }] : [])].sort(
    (a, b) => a.at - b.at,
  )[0];
  if (!soonest) return { count, expired: false };
  // Whole days left, like the certificate table's "in 29d17h" reads.
  const days = Math.floor((soonest.at - now) / DAY_MS);
  const detail = soonest.at <= now ? `${soonest.name} has expired` : days <= 0 ? `${soonest.name} expires today` : `${soonest.name} expires in ${days}d`;
  return { count, expired: soonest.at <= now, detail };
}

/** Operator resources that are not ready: per operator, the not-ready count. */
function operatorProblems(operators: OperatorRollup[] | undefined): { count: number; detail?: string } {
  if (!operators) return { count: 0 };
  const parts: string[] = [];
  let count = 0;
  for (const op of operators) {
    const n = op.resources.reduce((sum, r) => sum + (r.unavailable ? 0 : Math.max(r.issues.length, r.total - r.ready)), 0);
    if (n > 0) parts.push(`${op.name} ${n}`);
    count += n;
  }
  return { count, detail: parts.join(' · ') || undefined };
}

export interface AttentionSources {
  failingPods: OverviewProblemPod[];
  issues: OverviewWorkloadIssue[];
  warningEvents: OverviewWarningEvent[];
  certificates?: OverviewCertificates;
  operators?: OperatorRollup[];
  /**
   * Namespace scope: inventory problems no other tile covers (a degraded
   * ReplicaSet, a failing custom resource without an operator rollup).
   */
  otherProblems?: InventoryProblem[];
  /** Opens the pods list narrowed to the broken ones. */
  openPods: () => void;
  openEvents: () => void;
  now?: number;
}

/**
 * The overview's attention row, one tile per kind of trouble. Counts only;
 * zero tiles drop out in the renderer. Tiles jump to the section below that
 * lists the objects, or open the list when there is no such section.
 */
export function attentionItems(src: AttentionSources): AttentionItem[] {
  const now = src.now ?? Date.now();
  const certs = certificateCount(src.certificates, now);
  const ops = operatorProblems(src.operators);
  const workloadTone = src.issues.some((i) => issueTone(i) === 'error') ? 'error' : 'warning';
  return [
    {
      key: 'pods',
      tone: 'error',
      count: src.failingPods.length,
      label: src.failingPods.length === 1 ? 'failing pod' : 'failing pods',
      detail: failingPodBreakdown(src.failingPods.map((p) => p.reason)),
      action: 'Show pods',
      onClick: () => src.openPods(),
    },
    {
      key: 'workloads',
      tone: workloadTone,
      count: src.issues.length,
      label: src.issues.length === 1 ? 'unhealthy workload' : 'unhealthy workloads',
      detail: kindBreakdown(src.issues),
      action: 'Jump to list',
      onClick: (e) => jumpToAnchor(e.currentTarget, 'unhealthy-workloads'),
    },
    {
      key: 'warnings',
      tone: 'warning',
      count: src.warningEvents.length,
      label: src.warningEvents.length === 1 ? 'warning, last hour' : 'warnings, last hour',
      detail: reasonBreakdown(src.warningEvents),
      action: 'Show events',
      onClick: () => src.openEvents(),
    },
    {
      key: 'certificates',
      tone: certs.expired ? 'error' : 'warning',
      count: certs.count,
      label: certs.count === 1 ? 'certificate expiring' : 'certificates expiring',
      detail: certs.detail,
      action: 'Jump to list',
      onClick: (e) => jumpToAnchor(e.currentTarget, 'certificates'),
    },
    {
      key: 'other',
      tone: src.otherProblems?.some((p) => p.grade === 'failed') ? 'error' : 'warning',
      count: src.otherProblems?.length ?? 0,
      label: (src.otherProblems?.length ?? 0) === 1 ? 'other resource not healthy' : 'other resources not healthy',
      detail: src.otherProblems
        ? kindBreakdown(src.otherProblems.map((p) => ({ kind: p.kind, namespace: p.namespace, name: p.name })))
        : undefined,
      action: 'Jump to inventory',
      onClick: (e) => jumpToAnchor(e.currentTarget, 'inventory'),
    },
    {
      key: 'operators',
      tone: 'warning',
      count: ops.count,
      label: ops.count === 1 ? 'operator resource not ready' : 'operator resources not ready',
      detail: ops.detail,
      action: 'Jump to operators',
      onClick: (e) => jumpToAnchor(e.currentTarget, 'operators'),
    },
  ];
}
