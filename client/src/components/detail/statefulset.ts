import type { KubeObject } from '@kubus/shared';

/**
 * StatefulSet identity rules, pure: pods are `<set>-<ordinal>`, and each
 * volumeClaimTemplate gives every ordinal its own claim named
 * `<template>-<set>-<ordinal>`, which outlives the pod.
 */

export interface StatefulSetSpecShape {
  replicas?: number;
  serviceName?: string;
  ordinals?: { start?: number };
  volumeClaimTemplates?: Array<{
    metadata?: { name?: string };
    spec?: { storageClassName?: string; accessModes?: string[]; resources?: { requests?: { storage?: string } } };
  }>;
}

/** The ordinal in a StatefulSet pod's name, or undefined for a name that isn't one. */
export function podOrdinal(podName: string, setName: string): number | undefined {
  if (!podName.startsWith(`${setName}-`)) return undefined;
  const rest = podName.slice(setName.length + 1);
  return /^\d+$/.test(rest) ? Number(rest) : undefined;
}

/** Pods in ordinal order (web-2 before web-10); anything unnumbered goes last by name. */
export function sortByOrdinal(pods: KubeObject[], setName: string): KubeObject[] {
  const key = (pod: KubeObject) => podOrdinal(pod.metadata.name, setName) ?? Number.POSITIVE_INFINITY;
  return [...pods].sort((a, b) => key(a) - key(b) || a.metadata.name.localeCompare(b.metadata.name));
}

export interface ClaimRow {
  template: string;
  ordinal: number;
  /** The claim the controller creates (or created) for this ordinal. */
  claimName: string;
  pvc?: KubeObject;
  phase?: string;
  /** Provisioned size, or the requested size while the claim is unbound. */
  capacity?: string;
  storageClass?: string;
  /** An ordinal beyond the replica count whose claim was kept on scale-down. */
  retained: boolean;
}

/**
 * One row per volumeClaimTemplate × ordinal, joined with the claims that
 * exist. Claims left behind by a scale-down (the default retention) follow
 * as retained rows, so storage still being paid for stays visible.
 */
export function claimRows(set: KubeObject, pvcs: KubeObject[]): ClaimRow[] {
  const spec = set.spec as StatefulSetSpecShape | undefined;
  const templates = (spec?.volumeClaimTemplates ?? []).filter((t) => t.metadata?.name);
  if (!templates.length) return [];
  const start = spec?.ordinals?.start ?? 0;
  const replicas = spec?.replicas ?? 1;
  const setName = set.metadata.name;
  const byName = new Map(pvcs.map((p) => [p.metadata.name, p]));
  const ordinals = new Set<number>();
  for (let i = start; i < start + replicas; i++) ordinals.add(i);
  for (const t of templates) {
    const prefix = `${t.metadata!.name}-${setName}-`;
    for (const pvc of pvcs) {
      if (!pvc.metadata.name.startsWith(prefix)) continue;
      const rest = pvc.metadata.name.slice(prefix.length);
      if (/^\d+$/.test(rest)) ordinals.add(Number(rest));
    }
  }
  const rows: ClaimRow[] = [];
  for (const ordinal of [...ordinals].sort((a, b) => a - b)) {
    for (const t of templates) {
      const claimName = `${t.metadata!.name}-${setName}-${ordinal}`;
      const pvc = byName.get(claimName);
      const retained = ordinal < start || ordinal >= start + replicas;
      // A retained ordinal only matters for templates that left a claim.
      if (retained && !pvc) continue;
      const status = pvc?.status as { phase?: string; capacity?: { storage?: string } } | undefined;
      const pvcSpec = pvc?.spec as { storageClassName?: string; resources?: { requests?: { storage?: string } } } | undefined;
      rows.push({
        template: t.metadata!.name!,
        ordinal,
        claimName,
        pvc,
        phase: status?.phase,
        capacity: status?.capacity?.storage ?? pvcSpec?.resources?.requests?.storage ?? t.spec?.resources?.requests?.storage,
        storageClass: pvcSpec?.storageClassName ?? t.spec?.storageClassName,
        retained,
      });
    }
  }
  return rows;
}
