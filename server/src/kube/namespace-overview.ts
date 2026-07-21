import {
  BUILTIN_NAV_GROUPS,
  type KubeObject,
  type NamespaceInventoryEntry,
  type NamespaceOverview,
  type NamespaceQuotaStatus,
} from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';
import { resolveCrd } from './operator-rollups.js';
import { collectWarningEvents, optionalItems, podFailure } from './overview.js';
import { parseQuantity } from './quantity.js';
import { HEALTH_KINDS, computeWorkloadHealth, type HealthKindItems } from './workload-health.js';

/**
 * `kubectl get all -n <ns>`-style inventory: every namespaced builtin kind
 * from the nav catalog (Events excluded — they get their own section).
 */
const INVENTORY_KINDS = BUILTIN_NAV_GROUPS.flatMap((g) => g.kinds).filter((k) => k.namespaced && k.kind !== 'Event');

/**
 * Popular CRDs surfaced in the inventory when installed, `<plural>.<group>`.
 * Operator kinds (cert-manager, Argo, Flux, KEDA) show up through the
 * operator rollups too; the extras here are common cluster add-ons.
 */
const POPULAR_CRDS = [
  'certificates.cert-manager.io',
  'issuers.cert-manager.io',
  'applications.argoproj.io',
  'rollouts.argoproj.io',
  'kustomizations.kustomize.toolkit.fluxcd.io',
  'helmreleases.helm.toolkit.fluxcd.io',
  'gitrepositories.source.toolkit.fluxcd.io',
  'scaledobjects.keda.sh',
  'servicemonitors.monitoring.coreos.com',
  'prometheusrules.monitoring.coreos.com',
  'externalsecrets.external-secrets.io',
  'sealedsecrets.bitnami.com',
  'virtualservices.networking.istio.io',
  'httproutes.gateway.networking.k8s.io',
  'ingressroutes.traefik.io',
];

export async function computeNamespaceOverview(handle: ClusterHandle, namespaces: string[]): Promise<NamespaceOverview> {
  const scope = new Set(namespaces);
  const namespacesWatcher = handle.watchers.acquire('', 'v1', 'namespaces');
  const eventsWatcher = handle.watchers.acquire('', 'v1', 'events');
  const crdsWatcher = handle.watchers.acquire('apiextensions.k8s.io', 'v1', 'customresourcedefinitions');
  const inventoryWatchers = INVENTORY_KINDS.map((spec) => ({
    spec,
    handle: handle.watchers.acquire(spec.group, spec.version, spec.plural),
  }));
  try {
    await Promise.all([namespacesWatcher.watcher.ready(), eventsWatcher.watcher.ready()]);
    const [crdsResult, ...inventoryResults] = await Promise.all([
      optionalItems(crdsWatcher.watcher),
      ...inventoryWatchers.map((w) => optionalItems(w.handle.watcher)),
    ]);

    const inNamespace = (o: KubeObject) => scope.has(o.metadata.namespace ?? '');
    const itemsByKind = new Map<string, { items: KubeObject[]; unavailable: boolean }>();
    INVENTORY_KINDS.forEach((spec, i) => {
      const result = inventoryResults[i] ?? { items: [], unavailable: true };
      itemsByKind.set(spec.kind, {
        items: result.items.filter(inNamespace),
        unavailable: result.unavailable,
      });
    });

    // Unified health over the kinds that have a notion of it.
    const healthKinds: HealthKindItems[] = HEALTH_KINDS.map((spec) => {
      const entry = itemsByKind.get(spec.kind);
      return { spec, items: entry?.items ?? [], unavailable: entry?.unavailable ?? true };
    });
    const health = computeWorkloadHealth(healthKinds);
    const unhealthyByKind = new Map(health.kinds.map((k) => [k.kind, k.unhealthy]));

    const now = Date.now();
    const pods = itemsByKind.get('Pod')?.items ?? [];
    const failingPods = pods
      .flatMap((pod) => {
        const failure = podFailure(pod, now);
        return failure ? [{ namespace: pod.metadata.namespace ?? '', name: pod.metadata.name, ...failure }] : [];
      })
      .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
    unhealthyByKind.set('Pod', failingPods.length);

    const inventory: NamespaceInventoryEntry[] = INVENTORY_KINDS.map((spec) => {
      const entry = itemsByKind.get(spec.kind);
      return {
        kind: spec.kind,
        group: spec.group,
        version: spec.version,
        plural: spec.plural,
        total: entry?.items.length ?? 0,
        unhealthy: unhealthyByKind.get(spec.kind),
        unavailable: entry?.unavailable || undefined,
      };
    });

    // Installed popular CRDs, counted within the namespace.
    const crdsByName = new Map(crdsResult.items.map((c) => [c.metadata.name, c]));
    const installedCrds = POPULAR_CRDS.map((name) => resolveCrd(crdsByName, name)).filter(
      (crd): crd is NonNullable<typeof crd> => !!crd && crd.namespaced,
    );
    const crdCounts = await Promise.all(
      installedCrds.map(async (crd) => {
        const acquired = handle.watchers.acquire(crd.group, crd.version, crd.plural);
        try {
          const result = await optionalItems(acquired.watcher);
          return {
            kind: crd.kind,
            group: crd.group,
            version: crd.version,
            plural: crd.plural,
            total: result.items.filter(inNamespace).length,
            custom: true,
            unavailable: result.unavailable || undefined,
          };
        } finally {
          acquired.release();
        }
      }),
    );
    inventory.push(...crdCounts);

    const quotas: NamespaceQuotaStatus[] = (itemsByKind.get('ResourceQuota')?.items ?? []).map((quota) => {
      const status = quota.status as { hard?: Record<string, string>; used?: Record<string, string> } | undefined;
      return {
        name: scope.size > 1 ? `${quota.metadata.namespace}/${quota.metadata.name}` : quota.metadata.name,
        resources: Object.entries(status?.hard ?? {})
          .map(([resource, hard]) => {
            const hardVal = parseQuantity(hard);
            const used = status?.used?.[resource] ?? '0';
            return {
              resource,
              used,
              hard,
              pct: hardVal > 0 ? (parseQuantity(used) / hardVal) * 100 : undefined,
            };
          })
          .sort((a, b) => a.resource.localeCompare(b.resource)),
      };
    });

    const nsObject = scope.size === 1 ? namespacesWatcher.watcher.items().find((n) => scope.has(n.metadata.name)) : undefined;
    const events = eventsWatcher.watcher.items().filter(inNamespace);

    return {
      namespaces,
      status: (nsObject?.status as { phase?: string } | undefined)?.phase,
      inventory,
      workloadHealth: health.kinds,
      issues: health.issues,
      failingPods,
      quotas,
      warningEvents: collectWarningEvents(events, now, await handle.discovery.getResources().catch(() => [])),
    };
  } finally {
    namespacesWatcher.release();
    eventsWatcher.release();
    crdsWatcher.release();
    for (const w of inventoryWatchers) w.handle.release();
  }
}
