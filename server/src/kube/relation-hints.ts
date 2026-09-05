import type { KubeObject } from '@kubus/shared';

/**
 * Relationship inference for kinds Kubus has no schema knowledge of (custom
 * resources): every string in a spec or status is a hint, and a hint counts
 * as a reference to a kind when the field path names that kind and the
 * value matches an object name (or parses as a label selector that matches
 * an object's labels). Shared by the topology graph (forward: what does this
 * object point at) and the "Used by" section (reverse: who points at it).
 */

export interface RelationHint {
  path: string;
  value: string;
  selector?: Record<string, string>;
  referenceKind?: string;
  referenceNamespace?: string;
  /** API group named by a sibling `group` or `apiVersion` field (`''` for the core group); absent when unspecified. */
  referenceGroup?: string;
}

/** Plain map selector (Services, EDA node selectors): every pair must match; an empty map selects nothing. */
export function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  const entries = Object.entries(selector ?? {});
  return entries.length > 0 && entries.every(([k, v]) => labels?.[k] === v);
}

const IGNORED_RELATION_TERMS = new Set([
  'api',
  'change',
  'enabled',
  'generation',
  'health',
  'kind',
  'last',
  'metadata',
  'mode',
  'name',
  'namespace',
  'operating',
  'operational',
  'protocol',
  'reason',
  'resource',
  'score',
  'spec',
  'state',
  'status',
  'system',
  'time',
  'type',
  'version',
]);

const CAMEL_BOUNDARY_RE = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY_RE = /([A-Z]+)([A-Z][a-z])/g;
const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/;

/** Lower-case word tokens of a camelCase / dotted path, singularized, minus filler words. */
export function tokens(input: string): string[] {
  const spaced = input
    .replace(CAMEL_BOUNDARY_RE, '$1 $2')
    .replace(ACRONYM_BOUNDARY_RE, '$1 $2');
  return spaced
    .toLowerCase()
    .split(NON_ALPHANUMERIC_RE)
    .filter(Boolean)
    .map((token) => (token.endsWith('ies') ? `${token.slice(0, -3)}y` : token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token))
    .filter((token) => !IGNORED_RELATION_TERMS.has(token));
}

export function parseEqualitySelector(value: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.includes('!=')) return undefined;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key || !val) return undefined;
    out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

const URL_VALUE_RE = /^https?:\/\//i;

interface RelationContext {
  referenceKind?: string;
  referenceNamespace?: string;
  referenceGroup?: string;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** The API group a reference structure names: its `group`, or the group half of its `apiVersion` (`''` for core). */
function siblingGroup(record: Record<string, unknown>): string | undefined {
  if (typeof record.group === 'string') return record.group.trim();
  const apiVersion = trimmedString(record.apiVersion);
  if (!apiVersion) return undefined;
  const slash = apiVersion.indexOf('/');
  return slash === -1 ? '' : apiVersion.slice(0, slash);
}

/** Every short string leaf under a value, with its dotted path and the sibling kind/namespace context. */
export function collectRelationHints(value: unknown, prefix = '', context: RelationContext = {}): RelationHint[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 120 || URL_VALUE_RE.test(trimmed)) return [];
    return [{ path: prefix, value: trimmed, selector: parseEqualitySelector(trimmed), ...context }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectRelationHints(item, `${prefix}[${i}]`, context));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const siblingContext: RelationContext = {
      referenceKind: trimmedString(record.kind),
      referenceNamespace: trimmedString(record.namespace),
      referenceGroup: siblingGroup(record),
    };
    return Object.entries(record).flatMap(([key, item]) => collectRelationHints(item, prefix ? `${prefix}.${key}` : key, siblingContext));
  }
  return [];
}

const ARRAY_INDEX_RE = /\[\d+\]/g;

/** Short edge label for a hint path: its last two segments without indices. */
export function hintLabel(path: string): string {
  const parts = path.replace(ARRAY_INDEX_RE, '').split('.').filter(Boolean);
  return parts.slice(-2).join('.') || 'ref';
}

/** The full hint path without array indices, for "how" columns. */
export function hintPath(path: string): string {
  return path.replace(ARRAY_INDEX_RE, '');
}

const SELECTOR_KEY_RE = /(selector|matchLabels)$/i;

/** Map-shaped selectors (`podSelector.matchLabels`, `spec.selector`) anywhere under a value. */
export function collectMapSelectors(value: unknown, prefix = ''): Array<RelationContext & { path: string; selector: Record<string, string> }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => collectMapSelectors(item, `${prefix}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const out: Array<RelationContext & { path: string; selector: Record<string, string> }> = [];
  for (const [key, item] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SELECTOR_KEY_RE.test(key) && item && typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length && entries.every(([, v]) => typeof v === 'string')) {
        out.push({ path, selector: Object.fromEntries(entries) as Record<string, string>, referenceKind: trimmedString(record.kind), referenceNamespace: trimmedString(record.namespace), referenceGroup: siblingGroup(record) });
        continue;
      }
    }
    out.push(...collectMapSelectors(item, path));
  }
  return out;
}

/** What one object says about other objects: the fields that can name a kind, and its selectors. */
export interface ReferenceDigest {
  hints: RelationHint[];
  selectors: Array<{ path: string; selector: Record<string, string> }>;
}

/**
 * A memoized "does this field path name one of these kinds" test. Paths
 * repeat across every object of a kind, so the tokenization runs once per
 * distinct path instead of once per leaf of every object.
 */
export function createPathFilter(terms: Set<string>): (path: string) => boolean {
  const memo = new Map<string, boolean>();
  return (path) => {
    const key = path.replace(ARRAY_INDEX_RE, '');
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = tokens(key).some((term) => terms.has(term));
      memo.set(key, hit);
    }
    return hit;
  };
}

/** The head words and full names of every kind, the vocabulary a path filter checks against. */
export function kindVocabulary(kinds: Iterable<string>): Set<string> {
  const terms = new Set<string>();
  for (const kind of kinds) for (const term of kindHeadTerms(kind)) terms.add(term);
  return terms;
}

const OBJECT_NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** Whether a value can be an object name at all (a DNS subdomain): `SIMPLE`, `7220 IXR-H2` and `Null` cannot. */
export function looksLikeName(value: string): boolean {
  return OBJECT_NAME_RE.test(value);
}

/** Reduce an object to the hints that can name a known kind plus its selectors; everything else is dropped. */
export function digestObject(obj: KubeObject, namesKind: (path: string) => boolean): ReferenceDigest {
  const body = { spec: obj.spec, status: obj.status };
  const hints: RelationHint[] = [];
  const selectors: ReferenceDigest['selectors'] = [];
  for (const hint of collectRelationHints(body)) {
    if (hint.selector) {
      if (namesKind(hint.path)) selectors.push({ path: hint.path, selector: hint.selector });
      continue;
    }
    if (!looksLikeName(hint.value)) continue;
    if (!hint.referenceKind && !namesKind(hint.path)) continue;
    const kept: RelationHint = { path: hint.path, value: hint.value };
    if (hint.referenceKind) kept.referenceKind = hint.referenceKind;
    if (hint.referenceNamespace) kept.referenceNamespace = hint.referenceNamespace;
    if (hint.referenceGroup !== undefined) kept.referenceGroup = hint.referenceGroup;
    hints.push(kept);
  }
  for (const selector of collectMapSelectors(body)) {
    if (namesKind(selector.path)) selectors.push(selector);
  }
  return { hints, selectors };
}

/**
 * The description a CRD schema gives the field at a dotted path (array
 * indices ignored). The description of the deepest property on the way is
 * returned, so an array's description covers its items.
 */
export function schemaFieldDescription(schema: unknown, path: string): string | undefined {
  let node = schema as { properties?: Record<string, unknown>; items?: unknown; description?: unknown } | undefined;
  let description: string | undefined;
  for (const segment of path.replace(ARRAY_INDEX_RE, '.[]').split('.').filter(Boolean)) {
    if (!node || typeof node !== 'object') return description;
    node = (segment === '[]' ? node.items : node.properties?.[segment]) as typeof node;
    if (segment !== '[]' && typeof node?.description === 'string') description = node.description;
  }
  return description;
}

const NON_ALPHANUMERIC_ALL_RE = /[^a-z0-9]+/g;

/**
 * Whether prose names a kind: a multi-word kind anywhere in the text
 * ("select Toponodes"), a single-word kind only as a whole word written the
 * way the kind is ("Interface object", not "the interface speed") and only
 * when it is long enough not to be an everyday noun ("Interface", not "Node").
 */
export function textNamesKind(text: string, kind: string): boolean {
  if (tokens(kind).length > 1) return text.toLowerCase().replace(NON_ALPHANUMERIC_ALL_RE, '').includes(canonicalKind(kind));
  if (kind.length < 6) return false;
  return new RegExp(`\\b${kind}s?\\b`).test(text);
}

const REFERENCE_CUE_RE = /\b(refer(?:ence|ences|enced|s|ring)?|names? of|to use|used for|select(?:s|ed|or|ors)?|associated|object)\b/i;

/**
 * Whether a field description says the field points at a kind, as opposed
 * to merely mentioning it: "Reference to a TopoNode" and "Label selector
 * used to select Toponodes" do, "The version of the TopoNode" does not.
 */
export function descriptionNamesKind(description: string, kind: string): boolean {
  return REFERENCE_CUE_RE.test(description) && textNamesKind(description, kind);
}

export function collectMetadataRelationHints(obj: KubeObject): RelationHint[] {
  return [
    ...Object.entries(obj.metadata.labels ?? {}).map(([key, value]) => ({ path: `metadata.labels.${key}`, value })),
    ...Object.entries(obj.metadata.annotations ?? {}).map(([key, value]) => ({ path: `metadata.annotations.${key}`, value })),
  ];
}

const REFERENCE_CONTEXT_FIELDS = new Set(['apiversion', 'group', 'kind', 'namespace', 'version']);

export function canonicalKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * How strongly a hint's field path names the target kind: shared tokens
 * between the path and the kind/plural, a bonus for the whole kind spelled
 * out (`virtualnetwork` in a label key), and a decisive score when a sibling
 * `kind` field says so outright. Generic leaves (name, kind, namespace)
 * never count on their own.
 */
export function relationPathScore(hint: RelationHint, target: { kind: string; plural: string; group?: string }): number {
  const path = referencePath(hint.path);
  if (path === undefined) return 0;
  const pathScore = kindPathCoverage(path, target) + (tokens(path).includes(canonicalKind(target.kind)) ? 3 : 0);
  if (!hint.referenceKind) return pathScore;
  if (canonicalKind(hint.referenceKind) !== canonicalKind(target.kind)) return 0;
  // An explicit group settles which of several same-named kinds is meant.
  if (hint.referenceGroup !== undefined && target.group !== undefined && hint.referenceGroup !== target.group) return 0;
  return 100 + pathScore;
}

/**
 * The part of a field path that can name a kind: a trailing `name` leaf
 * defers to its parent (`secretRef.name` names a Secret), while other
 * context leaves (`kind`, `namespace`, `apiVersion`) name nothing themselves.
 */
export function referencePath(path: string): string | undefined {
  const parts = path.replace(ARRAY_INDEX_RE, '').split('.').filter(Boolean);
  const leaf = parts.at(-1)?.toLowerCase();
  if (!leaf) return undefined;
  if (leaf === 'name') return parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
  if (REFERENCE_CONTEXT_FIELDS.has(leaf)) return undefined;
  return path;
}

/**
 * How many distinct words of a field path the kind accounts for:
 * `spec.nodeProfile` is covered twice by NodeProfile and once by TopoNode,
 * which is what makes the field a NodeProfile reference. A kind that is one
 * generic word (`Node`) covers no more than a kind whose head word it is.
 */
export function kindPathCoverage(path: string, target: { kind: string; plural: string }): number {
  const targetTerms = new Set([...tokens(`${target.kind} ${target.plural}`), canonicalKind(target.kind)]);
  return new Set(tokens(path).filter((term) => targetTerms.has(term))).size;
}

export function bestTypedHint(hints: RelationHint[], target: { kind: string; plural: string; group?: string }): RelationHint | undefined {
  return hints
    .flatMap((hint) => {
      const score = relationPathScore(hint, target);
      return score > 0 ? [{ hint, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.hint.path.length - b.hint.path.length || a.hint.path.localeCompare(b.hint.path))[0]?.hint;
}

/**
 * The word that carries a kind's identity: its last camel-case token
 * (TopoNode → node, BridgeDomain → domain, IndexAllocationPool → pool) plus
 * the kind spelled out in one word. A field names the kind when it carries
 * one of these — `spec.members[].node`, `bridgeDomain`, `eviPool`,
 * `services.eda.nokia.com/virtualnetwork` — while `config` alone does not
 * name a ConfigMap.
 */
export function kindHeadTerms(kind: string): Set<string> {
  const parts = tokens(kind);
  const head = parts.at(-1);
  const terms = new Set<string>([canonicalKind(kind)]);
  if (head) terms.add(head);
  return terms;
}

/**
 * The part of a path that decides which kind a field points at: its last
 * segment when that segment names any kind at all (`interfaceResource` under
 * `spec.links[]` is an Interface, not a TopoLink), the whole path otherwise.
 */
export function referenceScope(path: string, namesAnyKind: (segment: string) => boolean): string {
  const full = referencePath(path) ?? path;
  const leaf = full.split('.').at(-1) ?? full;
  return namesAnyKind(leaf) ? leaf : full;
}

/** Whether a field path names the kind by its head word or full name (a trailing `name` leaf defers to its parent). */
export function pathNamesKind(path: string, kind: string): boolean {
  const heads = kindHeadTerms(kind);
  return tokens(referencePath(path) ?? '').some((term) => heads.has(term));
}

export interface SchemaMention {
  /** `strong` when a field or its description spells out the whole kind, `weak` when a field only carries the kind's head word. */
  strength: 'strong' | 'weak';
  /** Whether the mention sits under spec (desired state, hand-written references) rather than only under status. */
  inSpec: boolean;
}

const NON_ALPHANUMERIC_GLOBAL_RE = /[^a-z0-9]+/g;

/**
 * How a CRD's OpenAPI schema names a kind, if at all: `strong` when some
 * field spells out the whole kind (`topoNode`, `bridgeDomain`, `secretName`
 * for a Secret) or its description does ("Reference to a TopoNode"), `weak`
 * when a field only carries the kind's head word (`node` for TopoNode, which
 * just as well means a cluster node). Walks properties and array items under
 * spec and status; `additionalProperties` maps are skipped because their
 * keys are data, not field names.
 */
export function schemaKindMention(schema: unknown, kind: string, maxDepth = 12): SchemaMention | undefined {
  const heads = kindHeadTerms(kind);
  const kindTerms = tokens(kind);
  const whole = canonicalKind(kind);
  const seen = new Set<unknown>();
  let best: SchemaMention | undefined;
  const note = (strength: SchemaMention['strength'], inSpec: boolean) => {
    if (!best || (strength === 'strong' && best.strength === 'weak') || (strength === best.strength && inSpec && !best.inSpec)) best = { strength, inSpec };
  };
  const visit = (node: unknown, depth: number, inSpec: boolean): void => {
    if (!node || typeof node !== 'object' || depth > maxDepth || seen.has(node)) return;
    seen.add(node);
    const record = node as { properties?: Record<string, unknown>; items?: unknown };
    for (const [key, child] of Object.entries(record.properties ?? {})) {
      if (depth === 0 && key !== 'spec' && key !== 'status') continue;
      const under = depth === 0 ? key === 'spec' : inSpec;
      const keyTerms = tokens(key);
      const description = (child as { description?: unknown } | null)?.description;
      const describesKind = kindTerms.length > 1 && typeof description === 'string' && description.toLowerCase().replace(NON_ALPHANUMERIC_GLOBAL_RE, '').includes(whole);
      if (keyTerms.includes(whole) || (kindTerms.length > 1 && kindTerms.every((term) => keyTerms.includes(term))) || describesKind) note('strong', under);
      else if (keyTerms.some((term) => heads.has(term))) note('weak', under);
      if (best?.strength === 'strong' && best.inSpec) return;
      visit(child, depth + 1, under);
    }
    if (record.items) visit(record.items, depth + 1, inSpec);
  };
  visit(schema, 0, false);
  return best;
}

/** Whether a CRD schema names the kind at all; see `schemaKindMention`. */
export function schemaMentionsKind(schema: unknown, kind: string, maxDepth = 12): boolean {
  return schemaKindMention(schema, kind, maxDepth) !== undefined;
}
