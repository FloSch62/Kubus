import type { ResourceSelection } from '../ResourceDetailDrawer.js';
import type { ProblemLink } from './ProblemBanner.js';

// "pods "web-abc" is forbidden: exceeded quota: team-quota, requested: cpu=500m, ..."
const EXCEEDED_QUOTA_RE = /exceeded quota:\s*([a-z0-9]([-a-z0-9.]*[a-z0-9])?)/gi;

/** Names of ResourceQuotas an API error message blames, in order of appearance. */
export function quotaNamesIn(message: string | undefined): string[] {
  if (!message) return [];
  const names = new Set<string>();
  for (const match of message.matchAll(EXCEEDED_QUOTA_RE)) names.add(match[1]!);
  return [...names];
}

/**
 * Problem-banner links to the quotas an "exceeded quota" message names. The
 * quota lives in the same namespace as the object that was refused.
 */
export function quotaLinksFor(message: string | undefined, namespace: string | undefined, open: (selection: (ctx: string) => ResourceSelection) => void): ProblemLink[] | undefined {
  const names = quotaNamesIn(message);
  if (!names.length || !namespace) return undefined;
  return names.map((name) => ({
    label: `Open ResourceQuota ${name}`,
    onClick: () => open((ctx) => ({ ctx, group: '', version: 'v1', plural: 'resourcequotas', kind: 'ResourceQuota', name, namespace })),
  }));
}
