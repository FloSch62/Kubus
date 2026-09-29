import { BUILTIN_NAV_GROUPS, gvkForResource, type KubeObject, type SearchResult } from '@kubus/shared';
import { jobPhase, nodeStatus, podSummary, workloadReady, workloadStatus } from '../kube-display.js';

/**
 * Pure helpers behind the command palette: result categories, sibling
 * grouping, match highlighting and the status shown next to a result.
 */

export const PAGES_SECTION = 'Pages';
export const KINDS_SECTION = 'Kinds';
export const GITOPS_SECTION = 'Helm & GitOps';
export const CUSTOM_SECTION = 'Custom resources';
export const OTHER_BUILTIN_SECTION = 'Other built-in kinds';

const NAV_SECTION_BY_RESOURCE = new Map<string, string>();
for (const navGroup of BUILTIN_NAV_GROUPS) {
  for (const gvk of navGroup.kinds) NAV_SECTION_BY_RESOURCE.set(`${gvk.group}/${gvk.plural}`, navGroup.title);
}

/** Fixed order for sections whose best matches score the same. */
const SECTION_ORDER = [
  'Workloads',
  'Network',
  'Config',
  'Storage',
  'Cluster',
  'Access Control',
  GITOPS_SECTION,
  CUSTOM_SECTION,
  OTHER_BUILTIN_SECTION,
  KINDS_SECTION,
  PAGES_SECTION,
];

function isGitOpsGroup(group: string): boolean {
  return group === 'argoproj.io' || group.endsWith('.toolkit.fluxcd.io');
}

/** The palette section a search result belongs to. */
export function sectionFor(result: SearchResult): string {
  if (result.kind === 'page') return PAGES_SECTION;
  if (result.kind === 'kind') return KINDS_SECTION;
  const ref = result.ref;
  if (!ref) return OTHER_BUILTIN_SECTION;
  const nav = NAV_SECTION_BY_RESOURCE.get(`${ref.group}/${ref.plural}`);
  if (nav) return nav;
  if (ref.group === 'gateway.networking.k8s.io') return 'Network';
  if (isGitOpsGroup(ref.group)) return GITOPS_SECTION;
  if (gvkForResource(ref.group, ref.version, ref.plural)) return OTHER_BUILTIN_SECTION;
  return CUSTOM_SECTION;
}

/** Random pod-name suffix (`-x7k2p`) added by ReplicaSets, Jobs and DaemonSets. */
const POD_SUFFIX_RE = /^(.+)-([a-z0-9]{5})$/;

/** Siblings of one owner collapse once there are this many. */
export const SIBLING_GROUP_MIN = 3;

export type ResultEntry =
  | { type: 'result'; id: string; section: string; result: SearchResult; indent?: boolean }
  | {
      type: 'group';
      id: string;
      section: string;
      /** Name prefix shared by every member, without the trailing dash. */
      base: string;
      kind: string;
      ctx: string;
      namespace?: string;
      members: SearchResult[];
      expanded: boolean;
    };

/**
 * Search results as palette entries: grouped into sections (ordered by each
 * section's best match), with pods that share an owner prefix collapsed into
 * one expandable row. `expanded` holds the ids of groups the user opened.
 */
export function buildResultEntries(results: SearchResult[], expanded: ReadonlySet<string>): ResultEntry[] {
  const sections = new Map<string, { best: number; entries: ResultEntry[] }>();
  const groups = new Map<string, Extract<ResultEntry, { type: 'group' }>>();

  // First pass: find sibling sets big enough to collapse.
  const siblingCounts = new Map<string, number>();
  for (const result of results) {
    const key = siblingKey(result);
    if (key) siblingCounts.set(key, (siblingCounts.get(key) ?? 0) + 1);
  }

  for (const result of results) {
    const section = sectionFor(result);
    let bucket = sections.get(section);
    if (!bucket) {
      bucket = { best: result.score, entries: [] };
      sections.set(section, bucket);
    }
    bucket.best = Math.max(bucket.best, result.score);
    const key = siblingKey(result);
    if (key && (siblingCounts.get(key) ?? 0) >= SIBLING_GROUP_MIN && result.ref) {
      const id = `group:${key}`;
      const existing = groups.get(id);
      if (existing) {
        existing.members.push(result);
        continue;
      }
      const group: Extract<ResultEntry, { type: 'group' }> = {
        type: 'group',
        id,
        section,
        base: POD_SUFFIX_RE.exec(result.ref.name)?.[1] ?? result.ref.name,
        kind: result.ref.kind,
        ctx: result.ref.ctx,
        namespace: result.ref.namespace,
        members: [result],
        expanded: expanded.has(id),
      };
      groups.set(id, group);
      bucket.entries.push(group);
      continue;
    }
    bucket.entries.push({ type: 'result', id: result.id, section, result });
  }

  const ordered = [...sections.entries()].sort(
    ([a, x], [b, y]) => y.best - x.best || SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b),
  );
  const out: ResultEntry[] = [];
  for (const [, bucket] of ordered) {
    for (const entry of bucket.entries) {
      out.push(entry);
      if (entry.type === 'group' && entry.expanded) {
        for (const member of entry.members) out.push({ type: 'result', id: member.id, section: entry.section, result: member, indent: true });
      }
    }
  }
  return out;
}

function siblingKey(result: SearchResult): string | undefined {
  const ref = result.ref;
  if (result.kind !== 'resource' || !ref || ref.kind !== 'Pod') return undefined;
  const match = POD_SUFFIX_RE.exec(ref.name);
  if (!match) return undefined;
  return `${ref.ctx}|${ref.namespace ?? ''}|${ref.kind}|${match[1]}`;
}

export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * Split `text` into matched and unmatched parts for highlighting: the whole
 * query when it appears verbatim, otherwise every query token that does.
 */
export function highlightParts(text: string, query: string): TextPart[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  const whole = lower.indexOf(q);
  if (whole >= 0) ranges.push([whole, whole + q.length]);
  else {
    for (const token of q.split(/[\s/._-]+/).filter((t) => t.length > 1)) {
      const at = lower.indexOf(token);
      if (at >= 0) ranges.push([at, at + token.length]);
    }
  }
  if (!ranges.length) return [{ text, match: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts: TextPart[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) parts.push({ text: text.slice(pos, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    pos = end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), match: false });
  return parts;
}

/** Kinds whose status is worth a fetch per visible result. */
const STATUS_KINDS = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'Node', 'PersistentVolumeClaim', 'PersistentVolume', 'Namespace']);

export function hasPaletteStatus(kind: string): boolean {
  return STATUS_KINDS.has(kind);
}

export interface PaletteStatus {
  /** Status word that picks the color (see StatusChip). */
  status: string;
  /** Text to show; defaults to `status`. */
  label?: string;
}

/** The one-word status shown next to a result, or undefined when the kind has none. */
export function paletteStatus(kind: string, obj: KubeObject): PaletteStatus | undefined {
  switch (kind) {
    case 'Pod':
      return { status: podSummary(obj).status };
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet': {
      const status = workloadStatus(obj);
      return { status, label: status === 'Available' || status === 'Unavailable' || status === 'Progressing' ? workloadReady(obj) : status };
    }
    case 'Job':
      return { status: jobPhase(obj) };
    case 'Node':
      return { status: nodeStatus(obj).split(',')[0] ?? '' };
    default: {
      const phase = (obj.status as { phase?: string } | undefined)?.phase;
      return phase ? { status: phase } : undefined;
    }
  }
}

/**
 * One line summing up a sibling group's statuses, worst first:
 * "3 Running", "1 CrashLoopBackOff · 2 Running".
 */
export function groupStatusSummary(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => Number(a === 'Running') - Number(b === 'Running') || y - x)
    .map(([status, count]) => `${count} ${status}`)
    .join(' · ');
}
