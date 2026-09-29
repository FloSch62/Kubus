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
 * (empty namespace for cluster-scoped objects, empty group for core), read
 * the way cli-utils' ParseObjMetadata reads it: namespace up to the first
 * `_`, kind after the last, group before that, and the rest is the name,
 * whose colons are written as `__` (`system:auth-delegator`).
 */
export function parseInventoryEntry(id: string, version?: string): InventoryEntry | undefined {
  const first = id.indexOf('_');
  const last = id.lastIndexOf('_');
  const beforeKind = last > first ? id.lastIndexOf('_', last - 1) : -1;
  if (first === -1 || beforeKind <= first) return undefined;
  const name = id.slice(first + 1, beforeKind).replaceAll('__', ':');
  const kind = id.slice(last + 1);
  if (!name || !kind) return undefined;
  return { namespace: id.slice(0, first) || undefined, name, group: id.slice(beforeKind + 1, last), kind, version };
}

/** Inventory entries grouped for display: by kind, then namespace and name. */
export function inventory(obj: KubeObject): InventoryEntry[] {
  const entries = (obj.status as { inventory?: { entries?: Array<{ id?: string; v?: string }> } } | undefined)?.inventory?.entries ?? [];
  return entries
    .map((e) => (e.id ? parseInventoryEntry(e.id, e.v) : undefined))
    .filter((e): e is InventoryEntry => !!e)
    .sort((a, b) => a.kind.localeCompare(b.kind) || (a.namespace ?? '').localeCompare(b.namespace ?? '') || a.name.localeCompare(b.name));
}

export interface HelmHistoryEntry {
  name?: string;
  namespace?: string;
  version?: number;
  status?: string;
  chartName?: string;
  chartVersion?: string;
  appVersion?: string;
  firstDeployed?: string;
  lastDeployed?: string;
}

interface HelmReleaseShape {
  spec?: { releaseName?: string; targetNamespace?: string; storageNamespace?: string; chart?: { spec?: { chart?: string } } };
  status?: { history?: HelmHistoryEntry[]; storageNamespace?: string; lastReleaseRevision?: number; lastAppliedRevision?: string };
}

export interface HelmReleaseState {
  installed: boolean;
  revision?: number;
  chartName?: string;
  chartVersion?: string;
  appVersion?: string;
  /** The Helm release Flux manages, where Helm stores it (its release Secrets). */
  releaseName: string;
  storageNamespace: string;
  /** Newest first; on v2beta1, which keeps no history, the latest release alone. */
  history: HelmHistoryEntry[];
  latestOnly: boolean;
}

/**
 * What a HelmRelease says about its Helm release, on either API version:
 * v2 keeps `status.history`, v2beta1 (Flux 2.0 and 2.1) only
 * `lastReleaseRevision` and the chart version in `lastAppliedRevision`.
 * The storage namespace is where Helm keeps the release, which is not the
 * release's target namespace.
 */
export function helmReleaseState(obj: KubeObject): HelmReleaseState {
  const hr = obj as KubeObject & HelmReleaseShape;
  const status = hr.status ?? {};
  const spec = hr.spec ?? {};
  const history = status.history ?? [];
  const latest = history[0];
  const releaseName = latest?.name ?? spec.releaseName ?? (spec.targetNamespace ? `${spec.targetNamespace}-${obj.metadata.name}` : obj.metadata.name);
  const storageNamespace = status.storageNamespace ?? spec.storageNamespace ?? obj.metadata.namespace ?? '';
  if (latest || !status.lastReleaseRevision) {
    return {
      installed: !!latest,
      revision: latest?.version,
      chartName: latest?.chartName ?? spec.chart?.spec?.chart,
      chartVersion: latest?.chartVersion,
      appVersion: latest?.appVersion,
      releaseName,
      storageNamespace,
      history,
      latestOnly: false,
    };
  }
  const chartName = spec.chart?.spec?.chart;
  const entry: HelmHistoryEntry = { name: releaseName, version: status.lastReleaseRevision, chartName, chartVersion: status.lastAppliedRevision };
  return { installed: true, revision: status.lastReleaseRevision, chartName, chartVersion: status.lastAppliedRevision, releaseName, storageNamespace, history: [entry], latestOnly: true };
}
