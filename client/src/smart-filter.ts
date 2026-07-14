/**
 * Smart filter: structured query syntax for resource tables.
 *
 * A query is whitespace-separated clauses, ANDed together. Each clause is
 * either free text (substring match across name/namespace/cluster/status/
 * node/images/labels) or `key:value` / `key>value` / `key<value`. Values
 * with commas are alternatives (OR). `!` before a clause or its value
 * negates it. Quotes protect spaces: `name:"foo bar"`.
 *
 * Examples: `status:crash ns:prod`, `restarts>5`, `cpu>100m`, `mem>50%`,
 * `label:app=nginx age>2d !node:worker-1`, `type:lb`, `image:redis`.
 */
import type { KubeObject } from '@kubus/shared';
import type { ClusterRow } from './api/queries.js';
import type { MetricsLookup } from './components/columns.js';
import { eventFields, nodeStatus, parseQuantity, podSummary } from './kube-display.js';

export type FilterOp = ':' | '>' | '<' | '>=' | '<=';

export interface FilterClause {
  /** undefined → free-text clause */
  key?: string;
  op: FilterOp;
  /** OR-alternatives (comma-separated in the query), unquoted */
  values: string[];
  negated: boolean;
}

export interface FilterContext {
  kind: string;
  metrics?: MetricsLookup;
  nowMs: number;
}

/** Keys the parser recognizes; anything else falls back to free text. */
const KNOWN_KEYS = new Set([
  'name',
  'ns',
  'namespace',
  'cluster',
  'ctx',
  'label',
  'annotation',
  'status',
  'node',
  'image',
  'restarts',
  'ready',
  'age',
  'type',
  'replicas',
  'cpu',
  'mem',
  'memory',
  'reason',
  'message',
  'kind',
]);

const CLAUSE_RE = /^([a-zA-Z]+)(>=|<=|:|>|<)(.*)$/;
const WHITESPACE_RE = /\s/;

function splitTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (WHITESPACE_RE.test(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseSmartFilter(input: string): FilterClause[] {
  const clauses: FilterClause[] = [];
  for (let token of splitTokens(input)) {
    let negated = false;
    if (token.startsWith('!') && token.length > 1) {
      negated = true;
      token = token.slice(1);
    }
    const m = CLAUSE_RE.exec(token);
    if (m && KNOWN_KEYS.has(m[1]!.toLowerCase())) {
      let value = m[3]!;
      if (value.startsWith('!') && value.length > 1) {
        negated = !negated;
        value = value.slice(1);
      }
      // An empty value (still typing `status:`) matches everything rather
      // than flashing an empty table under the user's cursor.
      if (!value) continue;
      clauses.push({
        key: m[1]!.toLowerCase(),
        op: m[2] as FilterOp,
        values: value.split(',').filter(Boolean),
        negated,
      });
    } else if (token) {
      clauses.push({ op: ':', values: [token], negated });
    }
  }
  return clauses;
}

// ---- value helpers ----

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)([smhdw]?)$/;

/** Parse "90s" / "5m" / "2h" / "7d" / "1w" (default seconds) to seconds. */
function parseDuration(value: string): number | undefined {
  const m = DURATION_RE.exec(value.trim());
  if (!m) return undefined;
  return Number(m[1]) * (DURATION_UNITS[m[2] || 's'] ?? 1);
}

function compare(op: FilterOp, actual: number, expected: number): boolean {
  switch (op) {
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    default:
      return actual === expected;
  }
}

interface WorkloadCounts {
  desired: number;
  ready: number;
  updated?: number;
}

function workloadCounts(kind: string, obj: KubeObject): WorkloadCounts | undefined {
  const spec = obj.spec as { replicas?: number } | undefined;
  const status = obj.status as
    | {
        replicas?: number;
        readyReplicas?: number;
        updatedReplicas?: number;
        desiredNumberScheduled?: number;
        numberReady?: number;
        updatedNumberScheduled?: number;
      }
    | undefined;
  if (kind === 'DaemonSet') {
    return { desired: status?.desiredNumberScheduled ?? 0, ready: status?.numberReady ?? 0, updated: status?.updatedNumberScheduled };
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'ReplicaSet') {
    return { desired: spec?.replicas ?? status?.replicas ?? 0, ready: status?.readyReplicas ?? 0, updated: status?.updatedReplicas };
  }
  return undefined;
}

function jobState(obj: KubeObject): string {
  const status = obj.status as { active?: number; succeeded?: number; failed?: number; conditions?: Array<{ type: string; status: string }> } | undefined;
  if ((status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True')) return 'Failed';
  if ((status?.conditions ?? []).some((c) => c.type === 'Complete' && c.status === 'True')) return 'Complete';
  if ((status?.active ?? 0) > 0) return 'Active';
  return 'Pending';
}

/** The human status string the tables display, per kind. */
function statusText(kind: string, obj: KubeObject): string {
  if (kind === 'Pod') return podSummary(obj).status;
  if (kind === 'Node') return nodeStatus(obj);
  if (kind === 'Job') return jobState(obj);
  if (kind === 'CronJob') return (obj.spec as { suspend?: boolean } | undefined)?.suspend ? 'Suspended' : 'Active';
  const counts = workloadCounts(kind, obj);
  if (counts) {
    if (counts.desired === 0) return 'Scaled to zero';
    if (counts.ready >= counts.desired) return 'Running';
    return counts.updated !== undefined && counts.updated < counts.desired ? 'Progressing' : 'Degraded';
  }
  const phase = (obj.status as { phase?: string } | undefined)?.phase;
  if (phase) return phase;
  const conditions = (obj.status as { conditions?: Array<{ type: string; status: string }> } | undefined)?.conditions ?? [];
  const ready = conditions.find((c) => c.type === 'Ready' || c.type === 'Available' || c.type === 'Established');
  if (ready) return ready.status === 'True' ? 'Ready' : 'NotReady';
  return '';
}

const UNHEALTHY_STATUSES = new Set(['failed', 'notready', 'pending', 'lost', 'released']);

function isHealthy(kind: string, obj: KubeObject): boolean {
  if (kind === 'Pod') {
    const s = podSummary(obj);
    const phase = (obj.status as { phase?: string } | undefined)?.phase;
    if (phase === 'Succeeded') return true;
    const [ready, total] = s.ready.split('/').map(Number);
    return s.status === 'Running' && (ready ?? 0) >= (total ?? 0);
  }
  if (kind === 'Node') return nodeStatus(obj) === 'Ready';
  if (kind === 'Job') return jobState(obj) !== 'Failed';
  const counts = workloadCounts(kind, obj);
  if (counts) return counts.ready >= counts.desired;
  const text = statusText(kind, obj).toLowerCase();
  return !UNHEALTHY_STATUSES.has(text);
}

function isReady(kind: string, obj: KubeObject): boolean {
  if (kind === 'Pod') {
    const [ready, total] = podSummary(obj).ready.split('/').map(Number);
    return (ready ?? 0) >= (total ?? 0) && (total ?? 0) > 0;
  }
  const counts = workloadCounts(kind, obj);
  if (counts) return counts.ready >= counts.desired && counts.desired > 0;
  return isHealthy(kind, obj);
}

function podImages(obj: KubeObject): string[] {
  const spec = obj.spec as { containers?: Array<{ image?: string }>; initContainers?: Array<{ image?: string }> } | undefined;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c) => c.image ?? '').filter(Boolean);
}

const SERVICE_TYPE_ALIASES: Record<string, string> = {
  lb: 'loadbalancer',
  np: 'nodeport',
  cluster: 'clusterip',
  external: 'externalname',
};

const globRegExpCache = new Map<string, RegExp>();

function globRegExp(want: string): RegExp {
  let re = globRegExpCache.get(want);
  if (!re) {
    re = new RegExp(`^${want.split('*').map(escapeRegExp).join('.*')}$`, 'i');
    globRegExpCache.set(want, re);
  }
  return re;
}

const creationMsCache = new WeakMap<KubeObject, number>();

/** `Date.parse(creationTimestamp)`, cached per object (the timestamp is immutable). */
function creationMs(obj: KubeObject): number {
  let ms = creationMsCache.get(obj);
  if (ms === undefined) {
    ms = Date.parse(obj.metadata.creationTimestamp ?? '');
    creationMsCache.set(obj, ms);
  }
  return ms;
}

const lowerKeysCache = new WeakMap<Record<string, string>, string[]>();

function lowerKeys(map: Record<string, string>): string[] {
  let keys = lowerKeysCache.get(map);
  if (!keys) {
    keys = Object.keys(map).map((k) => k.toLowerCase());
    lowerKeysCache.set(map, keys);
  }
  return keys;
}

/** Match `label:key=value`, `label:key` (presence) with `*` globs in values. */
function matchKeyValueMap(map: Record<string, string> | undefined, raw: string): boolean {
  if (!map) return false;
  const eq = raw.indexOf('=');
  if (eq === -1) {
    const rawLower = raw.toLowerCase();
    return lowerKeys(map).some((k) => k.includes(rawLower));
  }
  const key = raw.slice(0, eq);
  const want = raw.slice(eq + 1);
  const actual = map[key];
  if (actual === undefined) return false;
  if (want.includes('*')) return globRegExp(want).test(actual);
  return actual.toLowerCase() === want.toLowerCase();
}

const REGEXP_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(s: string): string {
  return s.replace(REGEXP_SPECIALS_RE, '\\$&');
}

// ---- status alias predicates ----

type StatusPredicate = (kind: string, obj: KubeObject) => boolean;

const ERROR_STATUS_RE = /err|failed|backoff/;
const COMPLETED_STATUS_RE = /succeeded|complete/;

const STATUS_ALIASES: Record<string, StatusPredicate> = {
  crash: (k, o) => statusText(k, o).toLowerCase().includes('crashloop'),
  oom: (k, o) => statusText(k, o).toLowerCase().includes('oomkilled'),
  error: (k, o) => ERROR_STATUS_RE.test(statusText(k, o).toLowerCase()),
  unhealthy: (k, o) => !isHealthy(k, o),
  healthy: (k, o) => isHealthy(k, o),
  ok: (k, o) => isHealthy(k, o),
  completed: (k, o) => COMPLETED_STATUS_RE.test(statusText(k, o).toLowerCase()),
  degraded: (k, o) => statusText(k, o).toLowerCase() === 'degraded',
  progressing: (k, o) => statusText(k, o).toLowerCase() === 'progressing',
};

// ---- evaluation ----

const haystackCache = new WeakMap<KubeObject, { ctx: string; kind: string; text: string }>();

function freeTextHaystack(row: ClusterRow, kind: string): string {
  const obj = row.obj;
  const cached = haystackCache.get(obj);
  if (cached && cached.ctx === row.ctx && cached.kind === kind) return cached.text;
  const labels = Object.entries(obj.metadata.labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const parts = [obj.metadata.name, obj.metadata.namespace ?? '', row.ctx, statusText(kind, obj), labels];
  if (kind === 'Pod') parts.push(podSummary(obj).node ?? '', podImages(obj).join(' '));
  if (kind === 'Event') {
    const ev = eventFields(obj);
    parts.push(ev.reason, ev.message, ev.object);
  }
  const text = parts.join(' ').toLowerCase();
  haystackCache.set(obj, { ctx: row.ctx, kind, text });
  return text;
}

function matchClauseValue(clause: FilterClause, value: string, row: ClusterRow, ctx: FilterContext): boolean {
  const obj = row.obj;
  const v = value.toLowerCase();
  switch (clause.key) {
    case 'name':
      return obj.metadata.name.toLowerCase().includes(v);
    case 'ns':
    case 'namespace':
      return (obj.metadata.namespace ?? '').toLowerCase().includes(v);
    case 'cluster':
    case 'ctx':
      return row.ctx.toLowerCase().includes(v);
    case 'kind':
      return (obj.kind ?? ctx.kind).toLowerCase().includes(v);
    case 'label':
      return matchKeyValueMap(obj.metadata.labels, value);
    case 'annotation':
      return matchKeyValueMap(obj.metadata.annotations, value);
    case 'node': {
      const node = ctx.kind === 'Pod' ? podSummary(obj).node : ((obj.spec as { nodeName?: string } | undefined)?.nodeName ?? '');
      return (node ?? '').toLowerCase().includes(v);
    }
    case 'image':
      return podImages(obj).some((img) => img.toLowerCase().includes(v));
    case 'status': {
      const alias = STATUS_ALIASES[v];
      if (alias) return alias(ctx.kind, obj);
      return statusText(ctx.kind, obj).toLowerCase().includes(v);
    }
    case 'reason':
      return eventFields(obj).reason.toLowerCase().includes(v);
    case 'message':
      return eventFields(obj).message.toLowerCase().includes(v);
    case 'type': {
      if (ctx.kind === 'Service') {
        const svcType = ((obj.spec as { type?: string } | undefined)?.type ?? 'ClusterIP').toLowerCase();
        return svcType === (SERVICE_TYPE_ALIASES[v] ?? v) || svcType.includes(v);
      }
      const t = ((obj as { type?: string }).type ?? (obj.spec as { type?: string } | undefined)?.type ?? eventFields(obj).type).toLowerCase();
      return t.includes(v);
    }
    case 'ready': {
      if (v === 'true' || v === 'false') return isReady(ctx.kind, obj) === (v === 'true');
      return isReady(ctx.kind, obj);
    }
    case 'restarts': {
      const n = Number(value);
      if (Number.isNaN(n)) return false;
      return compare(clause.op, podSummary(obj).restarts, n);
    }
    case 'replicas': {
      const n = Number(value);
      if (Number.isNaN(n)) return false;
      const counts = workloadCounts(ctx.kind, obj);
      const actual = counts?.desired ?? (obj.spec as { replicas?: number } | undefined)?.replicas;
      if (actual === undefined) return false;
      return compare(clause.op, actual, n);
    }
    case 'age': {
      const seconds = parseDuration(value);
      const created = obj.metadata.creationTimestamp;
      if (seconds === undefined || !created) return false;
      const ageSeconds = (ctx.nowMs - creationMs(obj)) / 1000;
      return compare(clause.op, ageSeconds, seconds);
    }
    case 'cpu':
    case 'mem':
    case 'memory': {
      const m = ctx.metrics?.(row.ctx, obj.metadata.namespace, obj.metadata.name);
      if (!m) return false;
      const isCpu = clause.key === 'cpu';
      if (value.endsWith('%')) {
        const pct = Number(value.slice(0, -1));
        const capacity = isCpu ? m.cpuCapacityMilli : m.memCapacityBytes;
        if (Number.isNaN(pct) || !capacity) return false;
        const actual = ((isCpu ? m.cpuMilli : m.memBytes) / capacity) * 100;
        return compare(clause.op, actual, pct);
      }
      const expected = parseQuantity(value);
      if (!expected) return false;
      return isCpu ? compare(clause.op, m.cpuMilli, expected * 1000) : compare(clause.op, m.memBytes, expected);
    }
    default:
      return freeTextHaystack(row, ctx.kind).includes(v);
  }
}

export function matchesSmartFilter(row: ClusterRow, clauses: FilterClause[], ctx: FilterContext): boolean {
  for (const clause of clauses) {
    const matched = clause.values.some((value) => matchClauseValue(clause, value, row, ctx));
    if (matched === clause.negated) return false;
  }
  return true;
}

/** Plain search mode: every lowercased word must appear in the haystack. */
export function matchesPlainText(row: ClusterRow, words: string[], kind: string): boolean {
  const haystack = freeTextHaystack(row, kind);
  return words.every((word) => haystack.includes(word));
}

// ---- autocomplete suggestions ----

export interface FilterSuggestion {
  /** Text completing the current token, e.g. `status:` or `status:crash`. */
  completion: string;
  hint: string;
}

interface KeySuggestion {
  key: string;
  hint: string;
  /** Restrict to these kinds (undefined → all). */
  kinds?: string[];
  values?: Array<{ value: string; hint?: string }>;
}

const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'];

const KEY_SUGGESTIONS: KeySuggestion[] = [
  {
    key: 'status:',
    hint: 'status text or crash / oom / error / unhealthy / degraded',
    values: [
      { value: 'running' },
      { value: 'pending' },
      { value: 'crash', hint: 'CrashLoopBackOff' },
      { value: 'oom', hint: 'OOMKilled' },
      { value: 'error', hint: 'errors, failures, backoffs' },
      { value: 'unhealthy', hint: 'anything not fully up' },
      { value: 'completed' },
      { value: 'degraded', hint: 'ready < desired' },
      { value: 'progressing', hint: 'rollout in progress' },
    ],
  },
  { key: 'name:', hint: 'name contains' },
  { key: 'ns:', hint: 'namespace contains' },
  { key: 'cluster:', hint: 'cluster contains' },
  { key: 'label:', hint: 'label key=value or key presence' },
  { key: 'annotation:', hint: 'annotation key=value or key presence' },
  { key: 'age>', hint: 'older than (30s, 5m, 2h, 7d)' },
  { key: 'age<', hint: 'younger than (30s, 5m, 2h, 7d)' },
  { key: 'restarts>', hint: 'restart count above', kinds: ['Pod'] },
  { key: 'node:', hint: 'scheduled on node', kinds: ['Pod'] },
  { key: 'image:', hint: 'container image contains', kinds: ['Pod'] },
  { key: 'cpu>', hint: 'CPU above (100m, 1, 50%)', kinds: ['Pod', 'Node'] },
  { key: 'mem>', hint: 'memory above (256Mi, 1Gi, 50%)', kinds: ['Pod', 'Node'] },
  { key: 'ready:', hint: 'true / false', kinds: ['Pod', 'Node', ...WORKLOAD_KINDS], values: [{ value: 'true' }, { value: 'false' }] },
  { key: 'replicas>', hint: 'desired replicas above', kinds: WORKLOAD_KINDS },
  {
    key: 'type:',
    hint: 'service type (lb, np, cluster, external)',
    kinds: ['Service'],
    values: [
      { value: 'lb', hint: 'LoadBalancer' },
      { value: 'np', hint: 'NodePort' },
      { value: 'cluster', hint: 'ClusterIP' },
      { value: 'external', hint: 'ExternalName' },
    ],
  },
  { key: 'reason:', hint: 'event reason contains', kinds: ['Event'] },
  { key: 'message:', hint: 'event message contains', kinds: ['Event'] },
];

/**
 * Suggestions for the token being typed. `dynamicValues` supplies live
 * values (namespaces, clusters, nodes) keyed by filter key.
 */
export function smartFilterSuggestions(
  input: string,
  kind: string,
  dynamicValues: (key: string) => string[],
): FilterSuggestion[] {
  const beforeCursor = input;
  const lastSpace = Math.max(beforeCursor.lastIndexOf(' '), beforeCursor.lastIndexOf('\t'));
  const prefix = beforeCursor.slice(0, lastSpace + 1);
  let token = beforeCursor.slice(lastSpace + 1);
  let negation = '';
  if (token.startsWith('!')) {
    negation = '!';
    token = token.slice(1);
  }

  const out: FilterSuggestion[] = [];
  const keyMatch = CLAUSE_RE.exec(token);

  if (keyMatch) {
    const [, key, op, partial] = keyMatch;
    const keyLower = key!.toLowerCase();
    const partialLower = partial!.toLowerCase();
    const suggestion = KEY_SUGGESTIONS.find((s) => s.key.slice(0, -1) === keyLower);
    const statics = suggestion?.values ?? [];
    const dynamics = dynamicValues(keyLower).map((value) => ({ value, hint: undefined as string | undefined }));
    for (const { value, hint } of [...statics, ...dynamics]) {
      const valueLower = value.toLowerCase();
      if (partial && !valueLower.startsWith(partialLower)) continue;
      if (valueLower === partialLower) continue;
      out.push({ completion: `${prefix}${negation}${key}${op}${value}`, hint: hint ?? '' });
    }
    return out.slice(0, 12);
  }

  // Empty token (just `/`, or after a completed clause) → list all keys.
  const tokenLower = token.toLowerCase();
  for (const s of KEY_SUGGESTIONS) {
    if (s.kinds && !s.kinds.includes(kind)) continue;
    if (!s.key.toLowerCase().startsWith(tokenLower)) continue;
    out.push({ completion: `${prefix}${negation}${s.key}`, hint: s.hint });
  }
  return out.slice(0, 12);
}
