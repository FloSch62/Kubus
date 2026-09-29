import type { KubeObject } from '@kubus/shared';
import { conditionList, type DetailCondition } from '../nested-conditions.js';

/** Flux reading shared by Kustomizations, HelmReleases and the sources. */

// Stalled and Reconciling are the Flux conditions that are not good when True.
export const fluxGoodWhen = (type: string): 'True' | 'False' => (type === 'Stalled' || type === 'Reconciling' ? 'False' : 'True');

export function fluxConditions(obj: KubeObject): DetailCondition[] {
  return conditionList((obj.status as { conditions?: unknown } | undefined)?.conditions) ?? [];
}

export function fluxSuspended(obj: KubeObject): boolean {
  return !!(obj.spec as { suspend?: boolean } | undefined)?.suspend;
}

/** Flux status word for the drawer header. */
export function fluxHeaderStatus(obj: KubeObject): string | undefined {
  if (fluxSuspended(obj)) return 'Suspended';
  const conditions = fluxConditions(obj);
  if (conditions.some((c) => c.type === 'Stalled' && c.status === 'True')) return 'Stalled';
  const ready = conditions.find((c) => c.type === 'Ready');
  if (!ready) return undefined;
  if (ready.status === 'True') return 'Ready';
  if (ready.status === 'False') return 'NotReady';
  return 'Progressing';
}

export interface InventoryEntry {
  namespace?: string;
  name: string;
  group: string;
  kind: string;
  version?: string;
}

/**
 * A Kustomization inventory entry id, `<namespace>_<name>_<group>_<kind>`
 * (empty namespace for cluster-scoped objects, empty group for core).
 * Object names never contain `_`, so splitting is unambiguous.
 */
export function parseInventoryEntry(id: string, version?: string): InventoryEntry | undefined {
  const parts = id.split('_');
  if (parts.length !== 4 || !parts[1] || !parts[3]) return undefined;
  const [namespace, name, group, kind] = parts as [string, string, string, string];
  return { namespace: namespace || undefined, name, group, kind, version };
}

/** Inventory entries grouped for display: by kind, then namespace and name. */
export function inventory(obj: KubeObject): InventoryEntry[] {
  const entries = (obj.status as { inventory?: { entries?: Array<{ id?: string; v?: string }> } } | undefined)?.inventory?.entries ?? [];
  return entries
    .map((e) => (e.id ? parseInventoryEntry(e.id, e.v) : undefined))
    .filter((e): e is InventoryEntry => !!e)
    .sort((a, b) => a.kind.localeCompare(b.kind) || (a.namespace ?? '').localeCompare(b.namespace ?? '') || a.name.localeCompare(b.name));
}
