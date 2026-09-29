import type { KubeObject } from '@kubus/shared';
import type { SummaryTone } from '../SummaryStrip.js';

/** Argo CD Application reading: sync policy, sources, and what is wrong with it. */

export interface AppSource {
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
  ref?: string;
}

export interface AppSpec {
  project?: string;
  source?: AppSource;
  sources?: AppSource[];
  destination?: { server?: string; name?: string; namespace?: string };
  syncPolicy?: {
    automated?: { prune?: boolean; selfHeal?: boolean; allowEmpty?: boolean; enabled?: boolean } | null;
    syncOptions?: string[];
  };
}

export interface AppResource {
  group?: string;
  version?: string;
  kind: string;
  namespace?: string;
  name: string;
  status?: string;
  health?: { status?: string; message?: string };
}

export interface AppStatus {
  sync?: { status?: string; revision?: string; revisions?: string[] };
  health?: { status?: string; message?: string };
  operationState?: {
    phase?: string;
    message?: string;
    startedAt?: string;
    finishedAt?: string;
    operation?: { initiatedBy?: { username?: string; automated?: boolean }; sync?: { revision?: string; prune?: boolean } };
    syncResult?: { revision?: string };
  };
  resources?: AppResource[];
  conditions?: Array<{ type?: string; message?: string; lastTransitionTime?: string }>;
  reconciledAt?: string;
  summary?: { images?: string[]; externalURLs?: string[] };
}

export interface SyncPolicy {
  auto: boolean;
  prune: boolean;
  selfHeal: boolean;
  options: string[];
}

/** Auto-sync is on when `automated` is set and not explicitly disabled (Argo CD 2.14+ has `enabled`). */
export function appSyncPolicy(app: KubeObject): SyncPolicy {
  const policy = (app.spec as AppSpec | undefined)?.syncPolicy;
  const automated = policy?.automated;
  const auto = !!automated && automated.enabled !== false;
  return { auto, prune: auto && !!automated?.prune, selfHeal: auto && !!automated?.selfHeal, options: policy?.syncOptions ?? [] };
}

export function appSources(app: KubeObject): AppSource[] {
  const spec = app.spec as AppSpec | undefined;
  return spec?.sources?.length ? spec.sources : spec?.source ? [spec.source] : [];
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** A git commit as its 7-character short form; tags, branches and chart versions stay as they are. */
export function shortRevision(revision: string | undefined): string | undefined {
  if (!revision) return undefined;
  return SHA_RE.test(revision) ? revision.slice(0, 7) : revision;
}

export const SYNC_TONE: Record<string, SummaryTone> = { Synced: 'success', OutOfSync: 'warning' };
export const HEALTH_TONE: Record<string, SummaryTone> = { Healthy: 'success', Progressing: 'info', Suspended: 'warning', Missing: 'warning', Degraded: 'error' };

export interface AppProblem {
  title: string;
  message?: string;
  at?: string;
}

const RESOURCE_TROUBLE = new Set(['Degraded', 'Missing']);

/**
 * What needs attention on an Application: its own conditions (all of which
 * are errors or warnings), a failed last operation, degraded health, and the
 * managed resources that are degraded or missing, grouped by health.
 */
export function appProblems(app: KubeObject): AppProblem[] {
  const status = (app.status ?? {}) as AppStatus;
  const items: AppProblem[] = [];
  for (const c of status.conditions ?? []) items.push({ title: c.type ?? 'Condition', message: c.message, at: c.lastTransitionTime });
  const op = status.operationState;
  if (op && (op.phase === 'Failed' || op.phase === 'Error')) items.push({ title: `Last sync ${op.phase.toLowerCase()}`, message: op.message, at: op.finishedAt });
  if (status.health?.status === 'Degraded' && status.health.message) items.push({ title: 'Degraded', message: status.health.message });
  const troubled = (status.resources ?? []).filter((r) => RESOURCE_TROUBLE.has(r.health?.status ?? ''));
  for (const health of RESOURCE_TROUBLE) {
    const group = troubled.filter((r) => r.health?.status === health);
    if (!group.length) continue;
    const lines = group.slice(0, 5).map((r) => `${r.kind} ${r.namespace ? `${r.namespace}/` : ''}${r.name}${r.health?.message ? `: ${r.health.message}` : ''}`);
    if (group.length > 5) lines.push(`and ${group.length - 5} more`);
    items.push({ title: `${group.length} resource${group.length === 1 ? '' : 's'} ${health.toLowerCase()}`, message: lines.join('\n') });
  }
  return items;
}

const RESOURCE_RANK: Record<string, number> = { Degraded: 0, Missing: 1, Progressing: 2, Suspended: 3 };

/** Managed resources, the ones that need a look first: bad health, then out of sync, then by kind and name. */
export function sortedResources(app: KubeObject): AppResource[] {
  const list = [...(((app.status ?? {}) as AppStatus).resources ?? [])];
  const rank = (r: AppResource) => (RESOURCE_RANK[r.health?.status ?? ''] ?? 5) * 2 + (r.status === 'OutOfSync' ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Application health word for the drawer header. */
export function appHeaderStatus(app: KubeObject): string | undefined {
  return ((app.status ?? {}) as AppStatus).health?.status;
}

const IN_CLUSTER_SERVER = 'https://kubernetes.default.svc';

/**
 * Whether the Application deploys into the cluster it lives in, so its
 * managed resources are objects of the cluster being viewed. Anything
 * else (another server, a named remote cluster) is only named, not linked.
 */
export function appDeploysInCluster(app: KubeObject): boolean {
  const destination = (app.spec as AppSpec | undefined)?.destination;
  if (!destination) return false;
  if (destination.server) return destination.server.replace(/\/+$/, '') === IN_CLUSTER_SERVER;
  return destination.name === 'in-cluster';
}
