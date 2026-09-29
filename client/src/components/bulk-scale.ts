import type { KubeObject } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import { findOwningScaler, type OwningScaler } from './owning-scaler.js';

/** Kinds the multi-select bar can scale in one go. */
export const BULK_SCALE_KINDS = new Set(['Deployment', 'StatefulSet']);

/**
 * Past this many namespaces in one cluster, a single cluster-wide HPA list
 * replaces the per-namespace ones: select-all across 200 namespaces must not
 * fire 200 LISTs.
 */
export const HPA_LOOKUPS_PER_CLUSTER = 3;

export interface BulkScaleTarget {
  row: ClusterRow;
  current: number;
  /** HPA or ScaledObject that owns the replica count, if any. */
  scaler?: OwningScaler;
}

/** An HPA lookup: one namespace, or every namespace of the cluster when `namespace` is absent. */
export interface HpaScope {
  ctx: string;
  namespace?: string;
}

/**
 * The HPA lookups a selection needs: one per namespace while a cluster has
 * only a few, otherwise one for the whole cluster. Clusters in
 * `perNamespace` (their cluster-wide list failed, e.g. for lack of RBAC)
 * always get per-namespace lookups.
 */
export function bulkScaleScopes(rows: ClusterRow[], perNamespace: ReadonlySet<string> = new Set()): HpaScope[] {
  const byCluster = new Map<string, Set<string>>();
  for (const row of rows) {
    const namespaces = byCluster.get(row.ctx) ?? new Set<string>();
    namespaces.add(row.obj.metadata.namespace ?? '');
    byCluster.set(row.ctx, namespaces);
  }
  return [...byCluster].flatMap(([ctx, namespaces]) =>
    namespaces.size > HPA_LOOKUPS_PER_CLUSTER && !perNamespace.has(ctx) ? [{ ctx }] : [...namespaces].map((namespace) => ({ ctx, namespace })),
  );
}

/** Lookup results keyed by cluster and namespace; cluster-wide lists are split by each HPA's namespace. */
export function indexHpas(scopes: HpaScope[], lists: Array<KubeObject[] | undefined>): (ctx: string, namespace: string) => KubeObject[] | undefined {
  const index = new Map<string, KubeObject[]>();
  const clusterWide = new Set<string>();
  scopes.forEach((scope, i) => {
    const items = lists[i];
    if (!items) return;
    if (scope.namespace !== undefined) {
      index.set(`${scope.ctx}\0${scope.namespace}`, items);
      return;
    }
    clusterWide.add(scope.ctx);
    for (const hpa of items) {
      const key = `${scope.ctx}\0${hpa.metadata.namespace ?? ''}`;
      const list = index.get(key);
      if (list) list.push(hpa);
      else index.set(key, [hpa]);
    }
  });
  return (ctx, namespace) => index.get(`${ctx}\0${namespace}`) ?? (clusterWide.has(ctx) ? [] : undefined);
}

export function bulkScaleTargets(
  rows: ClusterRow[],
  kind: string,
  group: string,
  hpasFor: (ctx: string, namespace: string) => KubeObject[] | undefined,
): BulkScaleTarget[] {
  return rows.map((row) => ({
    row,
    current: (row.obj.spec as { replicas?: number } | undefined)?.replicas ?? 0,
    scaler: findOwningScaler({ kind, group, obj: row.obj }, hpasFor(row.ctx, row.obj.metadata.namespace ?? '')),
  }));
}

export interface BulkScaleSplit {
  /** Workloads the scale request goes to. */
  apply: BulkScaleTarget[];
  /** Autoscaled workloads left alone because the override is off. */
  skipped: BulkScaleTarget[];
  /** uids of `skipped`, for per-row lookups. */
  skippedUids: ReadonlySet<string>;
}

export function splitBulkScale(targets: BulkScaleTarget[], overrideAutoscaler: boolean): BulkScaleSplit {
  const apply = targets.filter((t) => overrideAutoscaler || !t.scaler);
  const skipped = targets.filter((t) => !overrideAutoscaler && t.scaler);
  return { apply, skipped, skippedUids: new Set(skipped.map((t) => t.row.obj.metadata.uid)) };
}

/**
 * Taking a running workload on a protected cluster to zero: the production
 * guard asks for typed confirmation, as the single Scale dialog does.
 */
export function bulkScaleGuarded(apply: BulkScaleTarget[], replicas: number, isProtected: (ctx: string) => boolean): boolean {
  return replicas === 0 && apply.some((t) => t.current > 0 && isProtected(t.row.ctx));
}

export interface BulkScalePlan extends BulkScaleSplit {
  guarded: boolean;
}

export function planBulkScale(targets: BulkScaleTarget[], replicas: number, overrideAutoscaler: boolean, isProtected: (ctx: string) => boolean): BulkScalePlan {
  const split = splitBulkScale(targets, overrideAutoscaler);
  return { ...split, guarded: bulkScaleGuarded(split.apply, replicas, isProtected) };
}

/** The replica count every target already has, when they agree. */
export function commonReplicas(targets: BulkScaleTarget[]): number | undefined {
  const first = targets[0]?.current;
  return first !== undefined && targets.every((t) => t.current === first) ? first : undefined;
}
