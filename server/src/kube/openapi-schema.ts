import type { ClusterHandle } from './cluster-manager.js';
import { HttpProblem } from '../util/errors.js';

interface OpenApiV3Discovery {
  paths?: Record<string, { serverRelativeURL?: string }>;
}

type SchemaNode = Record<string, unknown>;

interface OpenApiV3Doc {
  components?: { schemas?: Record<string, SchemaNode> };
}

const REF_PREFIX = '#/components/schemas/';

/**
 * Per-process cache of fetched group/version OpenAPI documents. The
 * serverRelativeURL embeds a content hash, so a key hit means the schema is
 * still current; CRD updates or apiserver upgrades change the URL. The
 * discovery document itself has no hash and is always fetched fresh.
 */
const docCache = new Map<string, Promise<OpenApiV3Doc>>();
const DOC_CACHE_MAX = 16;

function fetchGroupDoc(handle: ClusterHandle, relativeUrl: string): Promise<OpenApiV3Doc> {
  const key = `${handle.contextName}|${relativeUrl}`;
  let doc = docCache.get(key);
  if (!doc) {
    doc = handle.raw.json<OpenApiV3Doc>(relativeUrl);
    doc.catch(() => docCache.delete(key));
    if (docCache.size >= DOC_CACHE_MAX) {
      const oldest = docCache.keys().next().value;
      if (oldest !== undefined) docCache.delete(oldest);
    }
    docCache.set(key, doc);
  }
  return doc;
}

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) out.add(value.slice(REF_PREFIX.length));
    else collectRefs(value, out);
  }
}

/**
 * Kubernetes OpenAPI schemas leave objects open (no additionalProperties), so
 * plain JSON Schema validation would never flag misspelled fields. Close every
 * object that declares properties — mirroring the server's strict field
 * validation — except where the schema explicitly allows unknown fields.
 * Only recurses through schema positions (never through property-name maps),
 * so CRD fields literally named "properties" can't be mistaken for schemas.
 */
function closeObjectSchemas(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) closeObjectSchemas(item);
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  const node = schema as SchemaNode;
  const props = node.properties;
  if (
    props &&
    typeof props === 'object' &&
    (node.type === 'object' || node.type === undefined) &&
    node.additionalProperties === undefined &&
    node['x-kubernetes-preserve-unknown-fields'] !== true &&
    !Array.isArray(node.allOf) // never constrain composed schemas
  ) {
    node.additionalProperties = false;
  }
  if (props && typeof props === 'object') {
    for (const value of Object.values(props)) closeObjectSchemas(value);
  }
  closeObjectSchemas(node.items);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') closeObjectSchemas(node.additionalProperties);
  for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[combiner])) closeObjectSchemas(node[combiner]);
  }
  closeObjectSchemas(node.not);
}

function matchesGvk(def: SchemaNode, group: string, version: string, kind: string): boolean {
  const gvks = def['x-kubernetes-group-version-kind'];
  if (!Array.isArray(gvks)) return false;
  return gvks.some((entry) => {
    const g = entry as { group?: string; version?: string; kind?: string };
    return (g.group ?? '') === group && g.version === version && g.kind === kind;
  });
}

/**
 * Build a self-contained JSON Schema for one group/version/kind from the
 * cluster's OpenAPI v3 (which includes CRDs). The result roots at the kind's
 * definition and carries only the transitively referenced definitions, with
 * refs rewritten from OpenAPI components to JSON Schema definitions.
 */
export async function gvkJsonSchema(handle: ClusterHandle, group: string, version: string, kind: string): Promise<SchemaNode> {
  const discovery = await handle.raw.json<OpenApiV3Discovery>('/openapi/v3');
  const pathKey = group ? `apis/${group}/${version}` : `api/${version}`;
  const relativeUrl = discovery.paths?.[pathKey]?.serverRelativeURL;
  if (!relativeUrl) throw new HttpProblem(404, `no OpenAPI document for ${pathKey}`);

  const doc = await fetchGroupDoc(handle, relativeUrl);
  const allDefs = doc.components?.schemas ?? {};
  const rootName = Object.keys(allDefs).find((name) => matchesGvk(allDefs[name]!, group, version, kind));
  if (!rootName) throw new HttpProblem(404, `no schema for ${group || 'core'}/${version} ${kind}`);

  // Transitive closure of $refs from the root definition.
  const reachable = new Set<string>([rootName]);
  const queue = [rootName];
  while (queue.length) {
    const refs = new Set<string>();
    collectRefs(allDefs[queue.pop()!], refs);
    for (const ref of refs) {
      if (!reachable.has(ref) && allDefs[ref]) {
        reachable.add(ref);
        queue.push(ref);
      }
    }
  }

  const pruned: Record<string, SchemaNode> = {};
  for (const name of reachable) pruned[name] = allDefs[name]!;
  // Deep-copy via ref rewrite so closeObjectSchemas never mutates the cached doc.
  const definitions = JSON.parse(JSON.stringify(pruned).replaceAll(REF_PREFIX, '#/definitions/')) as Record<string, SchemaNode>;
  for (const def of Object.values(definitions)) closeObjectSchemas(def);

  return { $ref: `#/definitions/${rootName}`, definitions };
}
