import type { KubeObject } from '@kubus/shared';
import { conditionList, parentRefLabel, type DetailCondition } from '../nested-conditions.js';

/**
 * Gateway API reading: what a route matches and where it sends it, which
 * Gateways accepted it, and what a Gateway listens on. Defaults follow the
 * spec (a backendRef is a core Service unless it says otherwise, a parentRef
 * a Gateway in the route's namespace, a rule without matches is PathPrefix /).
 */

export const GATEWAY_GROUP = 'gateway.networking.k8s.io';

export interface ParentRef {
  group?: string;
  kind?: string;
  namespace?: string;
  name: string;
  sectionName?: string;
  port?: number;
}

export interface BackendRef {
  group?: string;
  kind?: string;
  name: string;
  namespace?: string;
  port?: number;
  weight?: number;
}

interface HeaderMatch {
  type?: string;
  name?: string;
  value?: string;
}

interface HttpMatch {
  path?: { type?: string; value?: string };
  headers?: HeaderMatch[];
  queryParams?: HeaderMatch[];
  method?: string;
}

interface GrpcMatch {
  method?: { type?: string; service?: string; method?: string };
  headers?: HeaderMatch[];
}

interface RouteFilter {
  type?: string;
  requestHeaderModifier?: HeaderModifier;
  responseHeaderModifier?: HeaderModifier;
  requestRedirect?: { scheme?: string; hostname?: string; port?: number; statusCode?: number; path?: { type?: string; replaceFullPath?: string; replacePrefixMatch?: string } };
  urlRewrite?: { hostname?: string; path?: { type?: string; replaceFullPath?: string; replacePrefixMatch?: string } };
  requestMirror?: { backendRef?: BackendRef; percent?: number };
  extensionRef?: { group?: string; kind?: string; name?: string };
}

interface HeaderModifier {
  set?: Array<{ name: string; value: string }>;
  add?: Array<{ name: string; value: string }>;
  remove?: string[];
}

export interface RouteRule {
  name?: string;
  matches?: Array<HttpMatch & GrpcMatch>;
  backendRefs?: BackendRef[];
  filters?: RouteFilter[];
  timeouts?: { request?: string; backendRequest?: string };
}

export interface RouteSpec {
  parentRefs?: ParentRef[];
  hostnames?: string[];
  rules?: RouteRule[];
}

interface RouteParentStatus {
  parentRef?: ParentRef;
  controllerName?: string;
  conditions?: unknown;
}

export interface BackendRow {
  group: string;
  kind: string;
  name: string;
  namespace: string;
  port?: number;
  weight: number;
  /** Percent of the rule's traffic, rounded; undefined when every weight is 0. */
  share?: number;
}

const headerText = (verb: string, h: HeaderMatch) => `${verb} ${h.name ?? '?'}${h.type === 'RegularExpression' ? ' ~ ' : ': '}${h.value ?? ''}`;

/** One line per clause of an HTTPRoute match: path, method, each header and query parameter. */
export function describeHttpMatch(match: HttpMatch): string[] {
  const lines: string[] = [];
  const path = match.path;
  lines.push(`${path?.type ?? 'PathPrefix'} ${path?.value ?? '/'}`);
  if (match.method) lines.push(`method ${match.method}`);
  for (const h of match.headers ?? []) lines.push(headerText('header', h));
  for (const q of match.queryParams ?? []) lines.push(headerText('query', q));
  return lines;
}

/** One line per clause of a GRPCRoute match: the service/method, then headers. */
export function describeGrpcMatch(match: GrpcMatch): string[] {
  const lines: string[] = [];
  const m = match.method;
  if (m) {
    const target = `${m.service ?? '*'}/${m.method ?? '*'}`;
    lines.push(m.type === 'RegularExpression' ? `method ~ ${target}` : `method ${target}`);
  }
  for (const h of match.headers ?? []) lines.push(headerText('header', h));
  return lines.length ? lines : ['any method'];
}

/** What a route kind matches on: HTTP requests, gRPC calls, or whole connections (TCP, TLS, UDP). */
export type RouteProtocol = 'http' | 'grpc' | 'stream';

export function routeProtocol(kind: string | undefined): RouteProtocol {
  return kind === 'HTTPRoute' ? 'http' : kind === 'GRPCRoute' ? 'grpc' : 'stream';
}

/** Match lines for a rule, one list per match (the matches are ORed); a rule without matches catches everything. */
export function ruleMatches(rule: RouteRule, protocol: RouteProtocol): string[][] {
  if (protocol === 'stream') return [['all connections']];
  const matches = rule.matches ?? [];
  if (!matches.length) return [[protocol === 'grpc' ? 'any method' : 'PathPrefix /']];
  return matches.map((m) => (protocol === 'grpc' ? describeGrpcMatch(m) : describeHttpMatch(m)));
}

/** Backends of a rule with defaults applied and each one's share of the traffic. */
export function ruleBackends(rule: RouteRule, routeNamespace: string): BackendRow[] {
  const refs = rule.backendRefs ?? [];
  const weights = refs.map((ref) => ref.weight ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  return refs.map((ref, i) => ({
    group: ref.group ?? '',
    kind: ref.kind ?? 'Service',
    name: ref.name,
    namespace: ref.namespace ?? routeNamespace,
    port: ref.port,
    weight: weights[i]!,
    share: total > 0 ? Math.round((weights[i]! / total) * 100) : undefined,
  }));
}

const modifierText = (m: HeaderModifier | undefined) =>
  [
    ...(m?.set ?? []).map((h) => `set ${h.name}: ${h.value}`),
    ...(m?.add ?? []).map((h) => `add ${h.name}: ${h.value}`),
    ...(m?.remove ?? []).map((h) => `remove ${h}`),
  ].join(', ');

const pathModifier = (p: { type?: string; replaceFullPath?: string; replacePrefixMatch?: string } | undefined) =>
  p ? (p.replaceFullPath !== undefined ? `path → ${p.replaceFullPath}` : p.replacePrefixMatch !== undefined ? `prefix → ${p.replacePrefixMatch}` : '') : '';

/** A filter as one readable line: "Rewrite prefix → /v2", "Redirect to https 301". */
export function describeFilter(filter: RouteFilter): string {
  switch (filter.type) {
    case 'RequestHeaderModifier':
      return `Request headers: ${modifierText(filter.requestHeaderModifier) || 'unchanged'}`;
    case 'ResponseHeaderModifier':
      return `Response headers: ${modifierText(filter.responseHeaderModifier) || 'unchanged'}`;
    case 'RequestRedirect': {
      const r = filter.requestRedirect;
      const target = [r?.scheme && `${r.scheme}://`, r?.hostname, r?.port && `:${r.port}`].filter(Boolean).join('');
      return ['Redirect', target && `to ${target}`, pathModifier(r?.path), r?.statusCode && String(r.statusCode)].filter(Boolean).join(' ');
    }
    case 'URLRewrite': {
      const r = filter.urlRewrite;
      return ['Rewrite', r?.hostname && `host → ${r.hostname}`, pathModifier(r?.path)].filter(Boolean).join(' ');
    }
    case 'RequestMirror': {
      const b = filter.requestMirror?.backendRef;
      return `Mirror to ${b?.name ?? '?'}${b?.port ? `:${b.port}` : ''}${filter.requestMirror?.percent !== undefined ? ` (${filter.requestMirror.percent}%)` : ''}`;
    }
    case 'ExtensionRef':
      return `Extension ${filter.extensionRef?.kind ?? ''} ${filter.extensionRef?.name ?? ''}`.trim();
    default:
      return filter.type ?? 'Filter';
  }
}

function sameParent(a: ParentRef, b: ParentRef, routeNamespace: string): boolean {
  return (
    a.name === b.name &&
    (a.namespace ?? routeNamespace) === (b.namespace ?? routeNamespace) &&
    (a.kind ?? 'Gateway') === (b.kind ?? 'Gateway') &&
    (a.group ?? GATEWAY_GROUP) === (b.group ?? GATEWAY_GROUP) &&
    (a.sectionName ?? '') === (b.sectionName ?? '') &&
    (a.port ?? 0) === (b.port ?? 0)
  );
}

export interface RouteParent {
  ref: ParentRef;
  label: string;
  /** One entry per controller that reported on this parent; empty when none has yet. */
  statuses: Array<{ controllerName?: string; conditions: DetailCondition[] }>;
}

/**
 * The route's parents as the spec lists them, each with whatever the
 * controllers reported for it; parents that only appear in status (a ref
 * removed from the spec that a controller still reports) come last.
 */
export function routeParents(route: KubeObject): RouteParent[] {
  const namespace = route.metadata.namespace ?? '';
  const spec = (route.spec ?? {}) as RouteSpec;
  const reported = ((route.status as { parents?: RouteParentStatus[] } | undefined)?.parents ?? []).filter((p): p is RouteParentStatus & { parentRef: ParentRef } => !!p.parentRef?.name);
  const used = new Set<number>();
  const toStatus = (p: RouteParentStatus) => ({ controllerName: p.controllerName, conditions: conditionList(p.conditions) ?? [] });
  const out: RouteParent[] = (spec.parentRefs ?? []).map((ref) => {
    const statuses: RouteParent['statuses'] = [];
    reported.forEach((p, i) => {
      if (!used.has(i) && sameParent(ref, p.parentRef, namespace)) {
        used.add(i);
        statuses.push(toStatus(p));
      }
    });
    return { ref, label: parentRefLabel(ref as unknown as Record<string, unknown>, namespace), statuses };
  });
  reported.forEach((p, i) => {
    if (!used.has(i)) out.push({ ref: p.parentRef, label: parentRefLabel(p.parentRef as unknown as Record<string, unknown>, namespace), statuses: [toStatus(p)] });
  });
  return out;
}

/** How many parents report a condition as True, out of how many parents there are. */
export function parentConditionCount(parents: RouteParent[], type: string): { ok: number; total: number } {
  const ok = parents.filter((p) => p.statuses.some((s) => s.conditions.some((c) => c.type === type && c.status === 'True'))).length;
  return { ok, total: parents.length };
}

/** Whether a route names a Gateway among its parents (defaults applied). */
export function routeAttachesTo(route: KubeObject, gateway: { name: string; namespace?: string }): boolean {
  const namespace = route.metadata.namespace ?? '';
  return ((route.spec as RouteSpec | undefined)?.parentRefs ?? []).some(
    (ref) => ref.name === gateway.name && (ref.namespace ?? namespace) === (gateway.namespace ?? '') && (ref.kind ?? 'Gateway') === 'Gateway' && (ref.group ?? GATEWAY_GROUP) === GATEWAY_GROUP,
  );
}

/** Gateway API conditions are positive except Conflicted, which is bad when True. */
export const gatewayGoodWhen = (type: string): 'True' | 'False' => (type === 'Conflicted' ? 'False' : 'True');

interface ListenerSpec {
  name: string;
  protocol?: string;
  port?: number;
  hostname?: string;
  tls?: { mode?: string; certificateRefs?: Array<{ group?: string; kind?: string; name: string; namespace?: string }> };
  allowedRoutes?: { namespaces?: { from?: string; selector?: unknown }; kinds?: Array<{ group?: string; kind: string }> };
}

interface ListenerStatus {
  name?: string;
  attachedRoutes?: number;
  supportedKinds?: Array<{ group?: string; kind: string }>;
  conditions?: unknown;
}

export interface ListenerRow {
  name: string;
  protocol?: string;
  port?: number;
  hostname?: string;
  tlsMode?: string;
  certificates: Array<{ group: string; kind: string; name: string; namespace?: string }>;
  /** "Same namespace", "All namespaces", "Selected namespaces". */
  namespaces: string;
  kinds: string[];
  attachedRoutes?: number;
  conditions: DetailCondition[];
}

const FROM_TEXT: Record<string, string> = { Same: 'Same namespace', All: 'All namespaces', Selector: 'Selected namespaces' };

/** Listeners as declared, joined with their status (attached route counts, conditions) by name. */
export function listenerRows(gateway: KubeObject): ListenerRow[] {
  const spec = (gateway.spec ?? {}) as { listeners?: ListenerSpec[] };
  const status = new Map(((gateway.status as { listeners?: ListenerStatus[] } | undefined)?.listeners ?? []).map((l) => [l.name, l]));
  return (spec.listeners ?? []).map((l) => {
    const st = status.get(l.name);
    const kinds = (l.allowedRoutes?.kinds ?? st?.supportedKinds ?? []).map((k) => k.kind);
    return {
      name: l.name,
      protocol: l.protocol,
      port: l.port,
      hostname: l.hostname,
      tlsMode: l.tls ? (l.tls.mode ?? 'Terminate') : undefined,
      certificates: (l.tls?.certificateRefs ?? []).map((c) => ({ group: c.group ?? '', kind: c.kind ?? 'Secret', name: c.name, namespace: c.namespace })),
      namespaces: FROM_TEXT[l.allowedRoutes?.namespaces?.from ?? 'Same'] ?? l.allowedRoutes?.namespaces?.from ?? 'Same namespace',
      kinds,
      attachedRoutes: st?.attachedRoutes,
      conditions: conditionList(st?.conditions) ?? [],
    };
  });
}

/** The first condition of a type, if present. */
export function conditionOf(obj: KubeObject, type: string): DetailCondition | undefined {
  return conditionList((obj.status as { conditions?: unknown } | undefined)?.conditions)?.find((c) => c.type === type);
}
