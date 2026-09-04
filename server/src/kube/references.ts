import type { KubeObject, ReferencesResponse, ResourceRef, UsedByEntry } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { installedCrds } from './overview.js';
import { resourcePath } from './raw-client.js';
import {
  canonicalKind,
  collectMapSelectors,
  collectMetadataRelationHints,
  collectRelationHints,
  descriptionNamesKind,
  hintPath,
  kindPathCoverage,
  looksLikeName,
  pathNamesKind,
  referenceScope,
  relationPathScore,
  schemaFieldDescription,
  selectorMatches,
  type RelationHint,
} from './relation-hints.js';
import { groupFamily } from './used-by.js';

/**
 * Forward references of one object: what it points at. Every string field
 * whose name (or, for custom kinds, whose schema description) names an
 * installed kind is treated as a reference to an object of that kind, and
 * selectors are resolved against labels. Existence is checked against the
 * live caches (search index for custom kinds, watcher caches for builtins)
 * and, for the few left over, with bounded GETs, so a dangling reference
 * shows up as such instead of as a link into nothing.
 */

export interface ReferenceSource {
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
}

interface KindSpec {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
  custom: boolean;
}

interface Labeled {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
}

interface CrdShape {
  group?: string;
  scope?: string;
  names?: { kind?: string; plural?: string };
  versions?: Array<{ name?: string; served?: boolean; storage?: boolean; schema?: { openAPIV3Schema?: unknown } }>;
}

const core = (plural: string, kind: string, namespaced = true): KindSpec => ({ group: '', version: 'v1', plural, kind, namespaced, custom: false });
const BUILTIN_KINDS: KindSpec[] = [
  core('configmaps', 'ConfigMap'),
  core('secrets', 'Secret'),
  core('services', 'Service'),
  core('serviceaccounts', 'ServiceAccount'),
  core('nodes', 'Node', false),
  core('namespaces', 'Namespace', false),
  core('persistentvolumeclaims', 'PersistentVolumeClaim'),
  core('persistentvolumes', 'PersistentVolume', false),
  core('pods', 'Pod'),
  { group: 'storage.k8s.io', version: 'v1', plural: 'storageclasses', kind: 'StorageClass', namespaced: false, custom: false },
  { group: 'scheduling.k8s.io', version: 'v1', plural: 'priorityclasses', kind: 'PriorityClass', namespaced: false, custom: false },
  { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true, custom: false },
  { group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet', namespaced: true, custom: false },
  { group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet', namespaced: true, custom: false },
  { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job', namespaced: true, custom: false },
  { group: 'batch', version: 'v1', plural: 'cronjobs', kind: 'CronJob', namespaced: true, custom: false },
  { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', kind: 'Ingress', namespaced: true, custom: false },
];

const MAX_GETS = 40;
const MAX_SELECTED = 100;
const MAX_VALUE_LENGTH = 120;
const METADATA_HINT_RE = /^metadata\.(labels|annotations)\./;

function crdSpecs(crds: KubeObject[]): KindSpec[] {
  const out: KindSpec[] = [];
  for (const crd of crds) {
    const spec = crd.spec as CrdShape | undefined;
    const versions = spec?.versions ?? [];
    const version = versions.find((v) => v.storage && v.served) ?? versions.find((v) => v.served);
    if (!spec?.group || !spec.names?.plural || !spec.names.kind || !version?.name) continue;
    out.push({ group: spec.group, version: version.name, plural: spec.names.plural, kind: spec.names.kind, namespaced: spec.scope === 'Namespaced', custom: true });
  }
  return out;
}

function crdSchema(crds: KubeObject[], source: ReferenceSource): unknown {
  for (const crd of crds) {
    const spec = crd.spec as CrdShape | undefined;
    if (spec?.group !== source.group || spec.names?.plural !== source.plural) continue;
    return (spec.versions ?? []).find((v) => v.name === source.version)?.schema?.openAPIV3Schema;
  }
  return undefined;
}

/**
 * The kinds a field can point at. A sibling `kind` field or the CRD's own
 * description of the field decides outright (`certain`); otherwise the kinds
 * the field name covers best, own group first, then the operator family,
 * then builtins, keeping every kind that ties. A guess from the field name
 * alone is only ever confirmed by an object that exists.
 */
export function kindsForHint(hint: RelationHint, kinds: KindSpec[], source: { group: string }, description?: string): { kinds: KindSpec[]; certain: boolean } {
  const family = groupFamily(source.group);
  const tier = (spec: KindSpec) => (spec.group === source.group ? 0 : groupFamily(spec.group) === family ? 1 : spec.custom ? 3 : 2);
  const bestTier = (list: KindSpec[]) => {
    const best = Math.min(...list.map(tier));
    return list.filter((spec) => tier(spec) === best);
  };
  if (hint.referenceKind) {
    const wanted = canonicalKind(hint.referenceKind);
    const named = kinds.filter((spec) => canonicalKind(spec.kind) === wanted);
    return { kinds: named.length ? bestTier(named) : [], certain: true };
  }
  if (description) {
    const named = kinds.filter((spec) => descriptionNamesKind(description, spec.kind));
    if (named.length) return { kinds: bestTier(named), certain: true };
  }
  // The last segment decides when it names a kind (`interfaceResource` under
  // `spec.links[]` is an Interface, not a TopoLink); otherwise the whole path.
  const scope = referenceScope(hint.path, (segment) => kinds.some((spec) => pathNamesKind(segment, spec.kind)));
  const named = kinds.filter((spec) => pathNamesKind(scope, spec.kind) && relationPathScore(hint, spec) > 0);
  if (!named.length) return { kinds: [], certain: false };
  const best = Math.max(...named.map((spec) => kindPathCoverage(scope, spec)));
  return { kinds: bestTier(named.filter((spec) => kindPathCoverage(scope, spec) === best)), certain: false };
}

function refFor(ctx: string, spec: KindSpec, obj: Labeled): ResourceRef {
  return {
    ctx,
    group: spec.group,
    version: spec.version,
    plural: spec.plural,
    kind: spec.kind,
    name: obj.name,
    namespace: spec.namespaced ? obj.namespace : undefined,
    uid: obj.uid ?? '',
  };
}

export async function computeReferences(handle: ClusterHandle, source: ReferenceSource): Promise<ReferencesResponse> {
  const obj = await handle.raw.json<KubeObject>(resourcePath(source.group, source.version, source.plural, { namespace: source.namespace, name: source.name }));
  let crds: KubeObject[] = [];
  const unavailable: string[] = [];
  try {
    crds = await installedCrds(handle);
  } catch {
    unavailable.push('CustomResourceDefinition');
  }
  const kinds = [...crdSpecs(crds), ...BUILTIN_KINDS];
  const schema = crdSchema(crds, source);
  const search = handle.searchIndex;
  search.warm();
  const rows = new Map<string, UsedByEntry>();
  const addRow = (spec: KindSpec, target: Labeled, relation: string, detail: string, missing = false) => {
    const ref = refFor(handle.contextName, spec, target);
    const id = `${ref.kind}|${ref.namespace ?? ''}|${ref.name}`;
    const existing = rows.get(id);
    if (existing) {
      if (!existing.detail?.split(', ').includes(detail)) existing.detail = existing.detail ? `${existing.detail}, ${detail}` : detail;
      if (!existing.relation.split(' · ').includes(relation)) existing.relation = `${existing.relation} · ${relation}`;
      return;
    }
    rows.set(id, { ref, relation, detail, ...(missing ? { missing: true } : {}) });
  };

  // Existence: live caches first, a bounded number of GETs for the rest.
  let gets = 0;
  const cachedLabeled = (spec: KindSpec): Labeled[] | undefined => {
    if (spec.custom) {
      return search.isLive(spec.group, spec.plural) ? search.entriesForKind(spec.group, spec.plural) : undefined;
    }
    const watcher = handle.watchers.peek(spec.group, spec.version, spec.plural);
    return watcher?.currentState() === 'live' ? watcher.items().map((item) => ({ name: item.metadata.name, namespace: item.metadata.namespace, uid: item.metadata.uid, labels: item.metadata.labels })) : undefined;
  };
  const exists = async (spec: KindSpec, namespace: string | undefined, name: string): Promise<{ found: boolean; uid?: string; verified: boolean }> => {
    if (spec.custom && search.isLive(spec.group, spec.plural)) {
      const entry = search.lookup(spec.group, spec.plural, spec.namespaced ? namespace : undefined, name);
      return { found: !!entry, uid: entry?.uid, verified: true };
    }
    const cached = cachedLabeled(spec);
    if (cached) {
      const hit = cached.find((item) => item.name === name && (!spec.namespaced || item.namespace === namespace));
      return { found: !!hit, uid: hit?.uid, verified: true };
    }
    if (gets >= MAX_GETS) return { found: true, verified: false };
    gets++;
    try {
      const got = await handle.raw.json<KubeObject>(resourcePath(spec.group, spec.version, spec.plural, { namespace: spec.namespaced ? namespace : undefined, name }));
      return { found: true, uid: got.metadata.uid, verified: true };
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404) return { found: false, verified: true };
      if (code === 403) unavailable.push(spec.kind);
      return { found: true, verified: false };
    }
  };

  const nameHints: Array<{ hint: RelationHint; relation: string; detail: string; fromSpec: boolean }> = [];
  for (const hint of collectRelationHints({ spec: obj.spec, status: obj.status })) {
    if (hint.selector || !looksLikeName(hint.value)) continue;
    nameHints.push({ hint, relation: 'references', detail: hintPath(hint.path), fromSpec: hint.path.startsWith('spec') });
  }
  for (const hint of collectMetadataRelationHints(obj)) {
    if (hint.value.length > MAX_VALUE_LENGTH || !looksLikeName(hint.value)) continue;
    const key = hint.path.replace(METADATA_HINT_RE, '');
    nameHints.push({ hint: { path: key, value: hint.value }, relation: hint.path.startsWith('metadata.labels.') ? 'labeled' : 'annotated', detail: key, fromSpec: false });
  }

  const resolutions = await Promise.all(
    nameHints.map(async ({ hint, relation, detail, fromSpec }) => {
      // Labels and annotations have no schema; spec and status fields may carry a description that names the kind.
      const description = schema && (fromSpec || hint.path.startsWith('status')) ? schemaFieldDescription(schema, hint.path) : undefined;
      const { kinds: candidates, certain } = kindsForHint(hint, kinds, source, description);
      if (!candidates.length) return undefined;
      const namespace = hint.referenceNamespace ?? source.namespace;
      const checks = await Promise.all(candidates.map(async (spec) => ({ spec, ...(await exists(spec, namespace, hint.value)) })));
      return { hint, relation, detail, fromSpec, certain, namespace, checks };
    }),
  );
  for (const resolution of resolutions) {
    if (!resolution) continue;
    const { hint, relation, detail, fromSpec, certain, namespace, checks } = resolution;
    const found = checks.filter((check) => check.found);
    if (found.length) {
      for (const check of found) addRow(check.spec, { name: hint.value, namespace, uid: check.uid }, relation, detail);
    } else if (fromSpec && certain && checks.length === 1 && checks[0]!.verified) {
      // Only a reference the schema vouches for is worth reporting as dangling.
      addRow(checks[0]!.spec, { name: hint.value, namespace }, relation, detail, true);
    }
  }

  // Selectors: resolve against the labels the caches hold.
  const body = { spec: obj.spec, status: obj.status };
  const selectorHints = [
    ...collectRelationHints(body).filter((hint) => hint.selector).map((hint) => ({ path: hint.path, selector: hint.selector! })),
    ...collectMapSelectors(body),
  ];
  for (const { path, selector } of selectorHints) {
    const description = schema && path.startsWith('spec') ? schemaFieldDescription(schema, path) : undefined;
    for (const spec of kindsForHint({ path, value: '' }, kinds, source, description).kinds) {
      const pool = cachedLabeled(spec);
      if (!pool) continue;
      const matches = pool
        .filter((item) => (!spec.namespaced || item.namespace === source.namespace) && selectorMatches(selector, item.labels))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_SELECTED);
      for (const item of matches) addRow(spec, item, 'selects', hintPath(path));
    }
  }

  return { items: [...rows.values()], unavailable: [...new Set(unavailable)] };
}
