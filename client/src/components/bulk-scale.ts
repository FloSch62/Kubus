import type { KubeObject } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import { findOwningScaler, type OwningScaler } from './owning-scaler.js';

/** Kinds the multi-select bar can scale in one go. */
export const BULK_SCALE_KINDS = new Set(['Deployment', 'StatefulSet']);

export interface BulkScaleTarget {
  row: ClusterRow;
  current: number;
  /** HPA or ScaledObject that owns the replica count, if any. */
  scaler?: OwningScaler;
}

/** One HPA lookup per cluster and namespace the selection touches. */
export function bulkScaleScopes(rows: ClusterRow[]): Array<{ ctx: string; namespace: string }> {
  const seen = new Map<string, { ctx: string; namespace: string }>();
  for (const row of rows) {
    const namespace = row.obj.metadata.namespace ?? '';
    seen.set(`${row.ctx}\0${namespace}`, { ctx: row.ctx, namespace });
  }
  return [...seen.values()];
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

export interface BulkScalePlan {
  /** Workloads the scale request goes to. */
  apply: BulkScaleTarget[];
  /** Autoscaled workloads left alone because the override is off. */
  skipped: BulkScaleTarget[];
  /**
   * Taking a running workload on a protected cluster to zero: the production
   * guard asks for typed confirmation, as the single Scale dialog does.
   */
  guarded: boolean;
}

export function planBulkScale(targets: BulkScaleTarget[], replicas: number, overrideAutoscaler: boolean, isProtected: (ctx: string) => boolean): BulkScalePlan {
  const apply = targets.filter((t) => overrideAutoscaler || !t.scaler);
  const skipped = targets.filter((t) => !overrideAutoscaler && t.scaler);
  const guarded = replicas === 0 && apply.some((t) => t.current > 0 && isProtected(t.row.ctx));
  return { apply, skipped, guarded };
}

/** The replica count every target already has, when they agree. */
export function commonReplicas(targets: BulkScaleTarget[]): number | undefined {
  const first = targets[0]?.current;
  return first !== undefined && targets.every((t) => t.current === first) ? first : undefined;
}
