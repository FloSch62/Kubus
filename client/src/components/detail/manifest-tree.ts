import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import type { JsonSchema, SchemaDefinitions } from './schema-walk.js';
import { mergedProperties, mergedRequired, resolveSchema } from './schema-walk.js';

/**
 * Pure helpers behind the manifest tree: paths and pointers, immutable
 * edits, base↔draft change tracking, filtering, schema-typed editing and
 * resource-reference detection. Rendering lives in ManifestTree.tsx.
 */

export type PathSegment = string | number;
export type JsonPath = ReadonlyArray<PathSegment>;

export const YAML_DUMP_OPTIONS = { noRefs: true, lineWidth: 140 } as const;

export function dumpManifest(obj: unknown): string {
  return dumpYaml(obj, YAML_DUMP_OPTIONS);
}

/** Parse YAML that must describe a single mapping (a manifest or a subtree). */
export function parseYamlMapping(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = loadYaml(text);
    if (!isPlainObject(parsed)) return { ok: false, error: 'The document must be a YAML mapping.' };
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse YAML for any value (used when editing a subtree as text). */
export function parseYamlValue(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: loadYaml(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ValueKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export function valueKind(value: unknown): ValueKind {
  if (Array.isArray(value)) return 'array';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

export function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

// ---- Paths ----

/** RFC 6901 pointer — the unambiguous key for a row ("/metadata/labels/app.kubernetes.io~1name"). */
export function pointerOf(path: JsonPath): string {
  return path.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** kubectl-style path (".spec.containers[0].image"); keys that aren't plain identifiers are quoted. */
export function displayPath(path: JsonPath): string {
  return path
    .map((segment) => {
      if (typeof segment === 'number') return `[${segment}]`;
      return IDENTIFIER_RE.test(segment) ? `.${segment}` : `["${segment.replace(/"/g, '\\"')}"]`;
    })
    .join('');
}

export function getAt(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') current = current[segment];
    else if (isPlainObject(current) && typeof segment === 'string') current = current[segment];
    else return undefined;
  }
  return current;
}

export function hasAt(root: unknown, path: JsonPath): boolean {
  if (path.length === 0) return root !== undefined;
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (Array.isArray(parent) && typeof last === 'number') return last < parent.length;
  if (isPlainObject(parent) && typeof last === 'string') return Object.hasOwn(parent, last);
  return false;
}

/** Immutable set: copies every container on the path, creating missing ones by segment type. */
export function setAt<T>(root: T, path: JsonPath, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [PathSegment, ...PathSegment[]];
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...(root as unknown[])] : [];
    list[head] = setAt(list[head], rest, value);
    return list as T;
  }
  const record: Record<string, unknown> = isPlainObject(root) ? { ...root } : {};
  record[head] = setAt(record[head], rest, value);
  return record as T;
}

/** Immutable delete; array segments splice so later items shift down. */
export function deleteAt<T>(root: T, path: JsonPath): T {
  if (path.length === 0) return undefined as T;
  const [head, ...rest] = path as [PathSegment, ...PathSegment[]];
  if (Array.isArray(root)) {
    if (typeof head !== 'number' || head >= root.length) return root;
    const list = [...(root as unknown[])];
    if (rest.length === 0) list.splice(head, 1);
    else {
      const child = deleteAt(list[head], rest);
      if (child === list[head]) return root;
      list[head] = child;
    }
    return list as T;
  }
  if (!isPlainObject(root) || typeof head !== 'string' || !Object.hasOwn(root, head)) return root;
  const record: Record<string, unknown> = { ...root };
  if (rest.length === 0) delete record[head];
  else {
    const child = deleteAt(record[head], rest);
    if (child === record[head]) return root;
    record[head] = child;
  }
  return record as T;
}

/** Immutable insert into the array at `path` (append when index is past the end). */
export function insertAt<T>(root: T, path: JsonPath, index: number, value: unknown): T {
  const list = getAt(root, path);
  const next = Array.isArray(list) ? [...list] : [];
  next.splice(Math.min(index, next.length), 0, value);
  return setAt(root, path, next);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

// ---- Change tracking ----

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface Change {
  kind: ChangeKind;
  path: PathSegment[];
}

export interface ChangeSet {
  /** Rows that differ, keyed by pointer. Arrays whose length changed count as one changed row. */
  rows: Map<string, Change>;
  /** Ancestors of changed rows — a collapsed parent shows "changes inside". */
  touched: Set<string>;
}

const EMPTY_CHANGES: ChangeSet = { rows: new Map(), touched: new Set() };

export function diffChanges(base: unknown, draft: unknown): ChangeSet {
  const rows = new Map<string, Change>();
  walkDiff(base, draft, [], rows);
  if (rows.size === 0) return EMPTY_CHANGES;
  const touched = new Set<string>();
  for (const pointer of rows.keys()) {
    const parts = pointer.split('/');
    for (let i = 2; i < parts.length; i += 1) touched.add(parts.slice(0, i).join('/'));
  }
  return { rows, touched };
}

function walkDiff(base: unknown, draft: unknown, path: PathSegment[], out: Map<string, Change>): void {
  if (deepEqual(base, draft)) return;
  if (isPlainObject(base) && isPlainObject(draft)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      const childPath = [...path, key];
      const pointer = pointerOf(childPath);
      if (!Object.hasOwn(base, key)) out.set(pointer, { kind: 'added', path: childPath });
      else if (!Object.hasOwn(draft, key)) out.set(pointer, { kind: 'removed', path: childPath });
      else walkDiff(base[key], draft[key], childPath, out);
    }
    return;
  }
  if (Array.isArray(base) && Array.isArray(draft) && base.length === draft.length) {
    base.forEach((item, i) => walkDiff(item, draft[i], [...path, i], out));
    return;
  }
  out.set(pointerOf(path), { kind: 'changed', path });
}

/**
 * Replay a draft's edits onto a newer snapshot of the object (after a 409):
 * every changed or added row is set to the draft's value, every removed row
 * is deleted. Rows the server changed underneath are overwritten by the
 * draft, which the review diff then shows.
 */
export function rebaseEdits<T>(base: unknown, draft: unknown, latest: T): T {
  let next = latest;
  for (const change of diffChanges(base, draft).rows.values()) {
    next = change.kind === 'removed' ? deleteAt(next, change.path) : setAt(next, change.path, getAt(draft, change.path));
  }
  return next;
}

// ---- Labels and summaries ----

const NATURAL_KEYS = ['name', 'type', 'key', 'containerPort', 'port', 'ip', 'host', 'path', 'kind', 'mountPath', 'hostname', 'id'];

/** Array item label: a natural key ("web", "Ready", "8080") when the item carries one, else the index. */
export function itemLabel(item: unknown, index: number): string {
  if (isPlainObject(item)) {
    for (const key of NATURAL_KEYS) {
      const value = item[key];
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number') return String(value);
    }
  }
  return String(index);
}

/** True when an array's items all carry natural keys (so the index is noise). */
export function hasNaturalKeys(list: unknown[]): boolean {
  return list.length > 0 && list.every((item, i) => itemLabel(item, i) !== String(i));
}

/**
 * What a collapsed list shows in its value cell: item labels for named lists
 * (containers, conditions), the items themselves for short scalar lists,
 * nothing for objects — the row's key already says what it is.
 */
export function collapsedPreview(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '';
  const labels = hasNaturalKeys(value)
    ? value.map(itemLabel)
    : value.every((item) => !isContainer(item))
      ? value.map((item) => truncate(scalarText(item), 32))
      : [];
  if (labels.length === 0) return '';
  const shown = labels.slice(0, 4).join(', ');
  return labels.length > 4 ? `${shown}, …` : shown;
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Short type label for the right column: "integer (int32)" → "int32", "array<object>" → "object[]". */
export function compactType(label: string): string {
  const formatted = /^([\w-]+) \((.+)\)$/.exec(label);
  if (formatted) return formatted[2] === 'byte' ? 'base64' : formatted[2]!;
  if (label.startsWith('array<') && label.endsWith('>')) return `${compactType(label.slice(6, -1))}[]`;
  if (label.startsWith('map<') && label.endsWith('>')) return `map<${compactType(label.slice(4, -1))}>`;
  switch (label) {
    case 'boolean':
      return 'bool';
    case 'integer':
      return 'int';
    case 'int-or-string':
      return 'int | string';
    default:
      return label;
  }
}

/** Schema descriptions arrive hard-wrapped; single breaks become spaces, blank lines stay paragraph breaks. */
export function normalizeDescription(text: string): string {
  return text
    .trim()
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Kubernetes resource quantities ("500m", "128Mi", "2") read as numbers. */
export const QUANTITY_RE = /^[+-]?\d+(?:\.\d+)?(?:m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

export function scalarText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// ---- Locking ----

const LOCKED_METADATA = new Set(['name', 'namespace', 'uid', 'resourceVersion', 'creationTimestamp', 'generation', 'managedFields', 'selfLink', 'deletionTimestamp', 'deletionGracePeriodSeconds']);

/**
 * Why a row can't be edited, or undefined when it can. Status belongs to the
 * controller (a PUT drops it anyway), identity fields to the API server, and
 * a redacted Secret's data would only ever write the placeholder back.
 */
export function lockReason(path: JsonPath, opts: { secretRedacted?: boolean } = {}): string | undefined {
  const [head, second] = path;
  if (path.length === 0) return undefined;
  if (head === 'apiVersion' || head === 'kind') return 'Identity fields cannot be edited.';
  if (head === 'status') return 'Status is written by the controller and is read-only here.';
  if (head === 'metadata' && typeof second === 'string' && LOCKED_METADATA.has(second)) return 'Identity fields cannot be edited.';
  if (opts.secretRedacted && (head === 'data' || head === 'stringData')) return 'Reveal the Secret to edit its data.';
  return undefined;
}

// ---- Default expansion ----

/**
 * Whether a container row starts expanded: shallow rows open unless they are
 * long lists (a node's hundred images), deep rows stay closed. `depth` is 0
 * for rows directly under a section root.
 */
export function defaultExpanded(value: unknown, depth: number): boolean {
  if (!isContainer(value)) return false;
  const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
  if (depth === 0) return count <= 12;
  if (depth === 1) return count <= 8;
  if (depth === 2) return count <= 5;
  return false;
}

// ---- Filtering ----

export interface FilterResult {
  /** Rows whose key or scalar value matches. */
  matches: Set<string>;
  /** Ancestors of matches — rendered open so the match is reachable. */
  open: Set<string>;
}

export function filterTree(root: unknown, rootPath: JsonPath, query: string): FilterResult | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const matches = new Set<string>();
  const open = new Set<string>();
  const visit = (value: unknown, path: PathSegment[], ancestors: string[]) => {
    const pointer = pointerOf(path);
    const key = path[path.length - 1];
    const keyMatch = typeof key === 'string' && key.toLowerCase().includes(needle);
    const valueMatch = !isContainer(value) && scalarText(value).toLowerCase().includes(needle);
    if (keyMatch || valueMatch) {
      matches.add(pointer);
      for (const ancestor of ancestors) open.add(ancestor);
    }
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i], [...ancestors, pointer]));
    else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) visit(v, [...path, k], [...ancestors, pointer]);
  };
  if (Array.isArray(root)) root.forEach((item, i) => visit(item, [...rootPath, i], []));
  else if (isPlainObject(root)) for (const [k, v] of Object.entries(root)) visit(v, [...rootPath, k], []);
  return { matches, open };
}

// ---- Schema-typed editing ----

export type EditorKind = 'boolean' | 'integer' | 'number' | 'enum' | 'string' | 'int-or-string' | 'yaml';

export function editorKindFor(schema: JsonSchema | undefined, value: unknown): EditorKind {
  if (isContainer(value)) return 'yaml';
  if (schema?.enum?.length) return 'enum';
  if (schema?.['x-kubernetes-int-or-string']) return 'int-or-string';
  const type = Array.isArray(schema?.type) ? schema.type.find((t) => t !== 'null') : schema?.type;
  if (type === 'boolean' || (!type && typeof value === 'boolean')) return 'boolean';
  if (type === 'integer') return 'integer';
  if (type === 'number' || (!type && typeof value === 'number')) return 'number';
  if (type === 'object' || type === 'array') return 'yaml';
  return 'string';
}

export function parseScalarInput(text: string, kind: EditorKind): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  switch (kind) {
    case 'boolean':
      if (trimmed === 'true') return { ok: true, value: true };
      if (trimmed === 'false') return { ok: true, value: false };
      return { ok: false, error: 'Enter true or false.' };
    case 'integer':
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: 'Enter a whole number.' };
      return { ok: true, value: Number(trimmed) };
    case 'number': {
      const n = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(n)) return { ok: false, error: 'Enter a number.' };
      return { ok: true, value: n };
    }
    case 'int-or-string':
      return { ok: true, value: /^-?\d+$/.test(trimmed) ? Number(trimmed) : text };
    case 'yaml':
      return parseYamlValue(text);
    default:
      return { ok: true, value: text };
  }
}

/** Starting value for a field added under a schema (its default when declared). */
export function emptyValueFor(schema: JsonSchema | undefined): unknown {
  if (schema?.default !== undefined) return schema.default;
  const type = Array.isArray(schema?.type) ? schema.type.find((t) => t !== 'null') : schema?.type;
  switch (type) {
    case 'object':
      return {};
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return 0;
    default:
      return schema?.enum?.[0] ?? '';
  }
}

export interface KeySuggestion {
  name: string;
  description?: string;
  required: boolean;
  schema: JsonSchema;
}

/** Schema properties not yet present on an object, required ones first. */
export function suggestedKeys(schema: JsonSchema | undefined, definitions: SchemaDefinitions, existing: Iterable<string>): KeySuggestion[] {
  if (!schema) return [];
  const present = new Set(existing);
  const required = new Set(mergedRequired(schema, definitions));
  return Object.entries(mergedProperties(schema, definitions))
    .filter(([name]) => !present.has(name))
    .map(([name, fieldSchema]) => {
      const resolved = resolveSchema(fieldSchema, definitions);
      return { name, description: resolved.description, required: required.has(name), schema: resolved };
    })
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

// ---- Resource references ----

export interface ResourceLink {
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
}

const KEY_KINDS: Record<string, string> = {
  nodeName: 'Node',
  serviceAccountName: 'ServiceAccount',
  secretName: 'Secret',
  claimName: 'PersistentVolumeClaim',
  storageClassName: 'StorageClass',
  priorityClassName: 'PriorityClass',
  runtimeClassName: 'RuntimeClass',
  ingressClassName: 'IngressClass',
  serviceName: 'Service',
};

const PARENT_KINDS: Record<string, string> = {
  configMapRef: 'ConfigMap',
  configMapKeyRef: 'ConfigMap',
  configMap: 'ConfigMap',
  secretRef: 'Secret',
  secretKeyRef: 'Secret',
  secret: 'Secret',
  imagePullSecrets: 'Secret',
};

/**
 * The resource a row points at, when its shape says so: `{kind, name}`
 * objects (owner references, scale targets, role refs) and the well-known
 * name fields of pod specs (nodeName, secretName, configMapRef.name…).
 */
export function referenceAt(path: JsonPath, value: unknown, ownerNamespace: string | undefined): ResourceLink | undefined {
  if (isPlainObject(value)) {
    const { kind, name, namespace, apiVersion } = value;
    if (typeof kind === 'string' && kind && typeof name === 'string' && name) {
      return { kind, name, namespace: typeof namespace === 'string' ? namespace : ownerNamespace, apiVersion: typeof apiVersion === 'string' ? apiVersion : undefined };
    }
    return undefined;
  }
  if (typeof value !== 'string' || !value) return undefined;
  const key = path[path.length - 1];
  if (typeof key !== 'string') return undefined;
  if (key === 'volumeName' && path.length === 2 && path[0] === 'spec') return { kind: 'PersistentVolume', name: value };
  const byKey = KEY_KINDS[key];
  if (byKey) return { kind: byKey, name: value, namespace: ownerNamespace };
  if (key === 'name') {
    // Walk past array indices: imagePullSecrets[0].name.
    let parentKey = path[path.length - 2];
    if (typeof parentKey === 'number') parentKey = path[path.length - 3];
    const byParent = typeof parentKey === 'string' ? PARENT_KINDS[parentKey] : undefined;
    if (byParent) return { kind: byParent, name: value, namespace: ownerNamespace };
  }
  return undefined;
}

/** Group and version from an apiVersion ("apps/v1" → apps + v1; "v1" → core). */
export function splitApiVersion(apiVersion: string | undefined): { group: string; version: string } {
  if (!apiVersion) return { group: '', version: '' };
  const slash = apiVersion.indexOf('/');
  return slash === -1 ? { group: '', version: apiVersion } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

// ---- Top-level layout ----

export interface ManifestGroup {
  key: string;
  title: string;
}

const LEADING_GROUPS = ['metadata', 'spec', 'status'];
const HIDDEN_ROOT_KEYS = new Set(['apiVersion', 'kind']);

/** Top-level keys as section groups: metadata, spec, status, then the rest in document order. */
export function manifestGroups(obj: Record<string, unknown>): ManifestGroup[] {
  const keys = Object.keys(obj).filter((key) => !HIDDEN_ROOT_KEYS.has(key));
  const ordered = [...LEADING_GROUPS.filter((key) => keys.includes(key)), ...keys.filter((key) => !LEADING_GROUPS.includes(key))];
  return ordered.map((key) => ({ key, title: key === 'metadata' ? 'Metadata' : key === 'spec' ? 'Spec' : key === 'status' ? 'Status' : key }));
}
