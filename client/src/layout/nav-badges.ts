import { groupToPath, type ClusterOverview } from '@kubus/shared';
import { issueTone } from '../components/overview/issue-cause.js';

/** A problem count next to a nav entry: red when something is failing, amber when degraded. */
export interface NavBadge {
  count: number;
  tone: 'error' | 'warning';
}

/** Nav target path → badge. Kinds with nothing wrong have no entry. */
export type NavBadges = Record<string, NavBadge>;

export const EVENTS_PAGE_PATH = '/events';
const PODS_PATH = '/r/core/v1/pods';

function add(badges: NavBadges, path: string, tone: NavBadge['tone'], count = 1): void {
  const current = badges[path];
  badges[path] = { count: (current?.count ?? 0) + count, tone: current?.tone === 'error' || tone === 'error' ? 'error' : 'warning' };
}

/**
 * Problem badges for the nav from the clusters' overview payloads (the same
 * cache the Overview page polls): failing pods on Pods, unhealthy objects on
 * their kind, warnings of the last hour on Events. A cluster narrowed to
 * namespaces in the global filter only counts what its lists would show.
 */
export function navBadges(overviews: Map<string, ClusterOverview> | undefined, namespacesByContext: Record<string, string[]>): NavBadges {
  const badges: NavBadges = {};
  for (const [ctx, overview] of overviews ?? []) {
    const scope = namespacesByContext[ctx];
    const inScope = (namespace: string) => !scope?.length || !namespace || scope.includes(namespace);
    const pods = overview.failingPods.filter((p) => inScope(p.namespace)).length;
    if (pods > 0) add(badges, PODS_PATH, 'error', pods);
    const gvrByKind = new Map(overview.workloadHealth.map((h) => [h.kind, h]));
    for (const issue of overview.unavailableWorkloads) {
      if (!inScope(issue.namespace)) continue;
      const gvr = gvrByKind.get(issue.kind);
      if (gvr) add(badges, `/r/${groupToPath(gvr.group)}/${gvr.version}/${gvr.plural}`, issueTone(issue));
    }
    const warnings = overview.warningEvents.filter((e) => inScope(e.namespace)).length;
    if (warnings > 0) add(badges, EVENTS_PAGE_PATH, 'warning', warnings);
  }
  return badges;
}

/** One badge for a collapsed group: the sum of its entries, red if any is red. */
export function groupBadge(badges: NavBadges, paths: string[]): NavBadge | undefined {
  let result: NavBadge | undefined;
  for (const path of paths) {
    const badge = badges[path];
    if (!badge) continue;
    result = { count: (result?.count ?? 0) + badge.count, tone: result?.tone === 'error' || badge.tone === 'error' ? 'error' : 'warning' };
  }
  return result;
}
