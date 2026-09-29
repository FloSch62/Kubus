import type { KubeObject, OperatorResourceRollup, OperatorRollup, OverviewWorkloadIssue } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';

/**
 * Health rollups for popular operators, driven by which CRDs the cluster has
 * installed. Only installed operators are returned; each resource is read
 * from the shared watcher cache (acquired on demand, lingers after release).
 */

export type ReadinessCheck = 'ready-condition' | 'argo-app' | 'argo-rollout' | 'route-parents';

interface OperatorResourceDef {
  /** CRD metadata.name, i.e. `<plural>.<group>`. */
  crd: string;
  check: ReadinessCheck;
}

interface OperatorDef {
  id: string;
  name: string;
  resources: OperatorResourceDef[];
}

const OPERATORS: OperatorDef[] = [
  {
    id: 'cert-manager',
    name: 'cert-manager',
    resources: [
      { crd: 'certificates.cert-manager.io', check: 'ready-condition' },
      { crd: 'issuers.cert-manager.io', check: 'ready-condition' },
      { crd: 'clusterissuers.cert-manager.io', check: 'ready-condition' },
    ],
  },
  {
    id: 'argo',
    name: 'Argo',
    resources: [
      { crd: 'applications.argoproj.io', check: 'argo-app' },
      { crd: 'rollouts.argoproj.io', check: 'argo-rollout' },
    ],
  },
  {
    id: 'flux',
    name: 'Flux',
    resources: [
      { crd: 'gitrepositories.source.toolkit.fluxcd.io', check: 'ready-condition' },
      { crd: 'ocirepositories.source.toolkit.fluxcd.io', check: 'ready-condition' },
      { crd: 'helmrepositories.source.toolkit.fluxcd.io', check: 'ready-condition' },
      { crd: 'kustomizations.kustomize.toolkit.fluxcd.io', check: 'ready-condition' },
      { crd: 'helmreleases.helm.toolkit.fluxcd.io', check: 'ready-condition' },
    ],
  },
  {
    id: 'external-secrets',
    name: 'External Secrets',
    resources: [
      { crd: 'externalsecrets.external-secrets.io', check: 'ready-condition' },
      { crd: 'secretstores.external-secrets.io', check: 'ready-condition' },
      { crd: 'clustersecretstores.external-secrets.io', check: 'ready-condition' },
    ],
  },
  {
    id: 'keda',
    name: 'KEDA',
    resources: [
      { crd: 'scaledobjects.keda.sh', check: 'ready-condition' },
      { crd: 'scaledjobs.keda.sh', check: 'ready-condition' },
    ],
  },
  {
    id: 'gateway-api',
    name: 'Gateway API',
    resources: [
      { crd: 'httproutes.gateway.networking.k8s.io', check: 'route-parents' },
      { crd: 'grpcroutes.gateway.networking.k8s.io', check: 'route-parents' },
    ],
  },
  {
    id: 'karpenter',
    name: 'Karpenter',
    resources: [
      { crd: 'nodepools.karpenter.sh', check: 'ready-condition' },
      { crd: 'nodeclaims.karpenter.sh', check: 'ready-condition' },
    ],
  },
];

const MAX_ISSUES_PER_RESOURCE = 20;

interface CrdSpec {
  group?: string;
  scope?: string;
  names?: { kind?: string; plural?: string };
  versions?: Array<{ name?: string; served?: boolean; storage?: boolean }>;
}

export interface InstalledCrd {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

/** Resolve a CRD by `<plural>.<group>` name to its served storage version. */
export function resolveCrd(crds: Map<string, KubeObject>, name: string): InstalledCrd | undefined {
  const crd = crds.get(name);
  if (!crd) return undefined;
  const spec = crd.spec as CrdSpec | undefined;
  const versions = spec?.versions ?? [];
  const version = versions.find((v) => v.storage && v.served) ?? versions.find((v) => v.served);
  if (!spec?.group || !spec.names?.plural || !spec.names.kind || !version?.name) return undefined;
  return {
    group: spec.group,
    version: version.name,
    plural: spec.names.plural,
    kind: spec.names.kind,
    namespaced: spec.scope === 'Namespaced',
  };
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

export interface Readiness {
  ready: boolean;
  reason?: string;
  message?: string;
  /** Not ready but still converging (reconciling, progressing, paused) rather than refused outright. */
  pending?: boolean;
}

export function readiness(check: ReadinessCheck, obj: KubeObject): Readiness {
  if (check === 'argo-app') {
    const status = obj.status as { health?: { status?: string; message?: string }; sync?: { status?: string } } | undefined;
    const health = status?.health?.status ?? 'Unknown';
    const sync = status?.sync?.status ?? 'Unknown';
    const ready = health === 'Healthy' && sync === 'Synced';
    if (ready) return { ready };
    return { ready, reason: health !== 'Healthy' ? health : sync, message: status?.health?.message, pending: health !== 'Degraded' && health !== 'Missing' };
  }
  if (check === 'argo-rollout') {
    const status = obj.status as { phase?: string; message?: string } | undefined;
    // No phase yet (not reconciled) — don't invent a failure; any explicit
    // non-Healthy phase (Progressing, Paused, Degraded) is not ready.
    if (!status?.phase || status.phase === 'Healthy') return { ready: true };
    return { ready: false, reason: status.phase, message: status.message, pending: status.phase !== 'Degraded' };
  }
  if (check === 'route-parents') {
    // Gateway API routes report per parent Gateway. No parent status yet
    // (no controller) is not a failure; a parent that refuses the route or
    // cannot resolve its backends is.
    const parents = (obj.status as { parents?: Array<{ conditions?: Condition[] }> } | undefined)?.parents ?? [];
    const conditions = parents.flatMap((p) => p.conditions ?? []).filter((c) => c.type === 'Accepted' || c.type === 'ResolvedRefs');
    const bad = conditions.find((c) => c.status === 'False') ?? conditions.find((c) => c.status === 'Unknown');
    if (!bad) return { ready: true };
    return { ready: false, reason: bad.reason ?? `Not${bad.type ?? 'Accepted'}`, message: bad.message, pending: bad.status === 'Unknown' };
  }
  const conditions = (obj.status as { conditions?: Condition[] } | undefined)?.conditions ?? [];
  const readyCond = conditions.find((c) => c.type === 'Ready');
  // No Ready condition at all (not yet reconciled schema, cluster-scoped
  // config objects) — don't invent a failure.
  if (!readyCond || readyCond.status === 'True') return { ready: true };
  return { ready: false, reason: readyCond.reason ?? 'NotReady', message: readyCond.message, pending: readyCond.status !== 'False' };
}

/** The readiness check an operator rollup uses for a CRD (`<plural>.<group>`), if any. */
export function operatorCheckFor(crdName: string): ReadinessCheck | undefined {
  for (const op of OPERATORS) {
    const def = op.resources.find((r) => r.crd === crdName);
    if (def) return def.check;
  }
  return undefined;
}

export async function computeOperatorRollups(handle: ClusterHandle, crds: KubeObject[], namespaces?: ReadonlySet<string>): Promise<OperatorRollup[]> {
  const crdsByName = new Map(crds.map((c) => [c.metadata.name, c]));
  const rollups: OperatorRollup[] = [];
  for (const op of OPERATORS) {
    const installed = op.resources
      .map((r) => ({ def: r, crd: resolveCrd(crdsByName, r.crd) }))
      .filter((r): r is { def: OperatorResourceDef; crd: InstalledCrd } => !!r.crd)
      // A namespace-scoped view has nothing to say about cluster-scoped resources.
      .filter((r) => !namespaces || r.crd.namespaced);
    if (installed.length === 0) continue;
    const resources = await Promise.all(installed.map(({ def, crd }) => rollupResource(handle, def, crd, namespaces)));
    rollups.push({ id: op.id, name: op.name, resources });
  }
  return rollups;
}

async function rollupResource(
  handle: ClusterHandle,
  def: OperatorResourceDef,
  crd: InstalledCrd,
  namespaces?: ReadonlySet<string>,
): Promise<OperatorResourceRollup> {
  const { watcher, release } = handle.watchers.acquire(crd.group, crd.version, crd.plural);
  try {
    let items: KubeObject[] = [];
    let unavailable = false;
    try {
      await watcher.ready();
      items = watcher.items();
      unavailable = watcher.currentState() === 'unavailable';
    } catch {
      unavailable = true;
    }
    if (namespaces) items = items.filter((o) => namespaces.has(o.metadata.namespace ?? ''));
    const issues: OverviewWorkloadIssue[] = [];
    let ready = 0;
    for (const obj of items) {
      const r = readiness(def.check, obj);
      if (r.ready) {
        ready += 1;
      } else if (issues.length < MAX_ISSUES_PER_RESOURCE) {
        issues.push({
          kind: crd.kind,
          namespace: obj.metadata.namespace ?? '',
          name: obj.metadata.name,
          reason: r.reason ?? 'NotReady',
          message: r.message,
        });
      }
    }
    issues.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
    return {
      kind: crd.kind,
      group: crd.group,
      version: crd.version,
      plural: crd.plural,
      namespaced: crd.namespaced,
      total: items.length,
      ready,
      issues,
      unavailable: unavailable || undefined,
    };
  } finally {
    release();
  }
}
