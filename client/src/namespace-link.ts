import { appNavigate } from './app-navigate.js';
import { useClustersStore } from './state/clusters.js';

/**
 * The namespace shown on every detail is a link to that namespace's
 * overview: the global filter narrows to it (for that cluster only) and the
 * Overview page renders its namespace-scoped view. Kubus has no separate
 * namespace page — the overview under a filter is that page.
 */
export function openNamespaceOverview(ctx: string, namespace: string): void {
  const clusters = useClustersStore.getState();
  clusters.setNamespaces([namespace], [ctx]);
  if (!clusters.selected.includes(ctx)) clusters.setSelected([...clusters.selected, ctx]);
  appNavigate('/');
}
