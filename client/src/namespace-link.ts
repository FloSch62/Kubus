import { appNavigate } from './app-navigate.js';
import { kindListPath } from './resource-links.js';
import { useClustersStore } from './state/clusters.js';

/** Narrow the global namespace filter to one namespace, for that cluster only. */
function scopeToNamespace(ctx: string, namespace: string): void {
  const clusters = useClustersStore.getState();
  clusters.setNamespaces([namespace], [ctx]);
  if (!clusters.selected.includes(ctx)) clusters.setSelected([...clusters.selected, ctx]);
}

/**
 * The namespace shown on every detail is a link to that namespace's
 * overview: the global filter narrows to it (for that cluster only) and the
 * Overview page renders its namespace-scoped view. Kubus has no separate
 * namespace page — the overview under a filter is that page.
 */
export function openNamespaceOverview(ctx: string, namespace: string): void {
  scopeToNamespace(ctx, namespace);
  appNavigate('/');
}

/**
 * A kind's list scoped to one namespace, the way the scoped overview's
 * inventory links get there: the same global filter, then the plain list.
 */
export function openNamespaceList(ctx: string, namespace: string, gvr: { group: string; version: string; plural: string }): void {
  scopeToNamespace(ctx, namespace);
  appNavigate(kindListPath(gvr));
}
