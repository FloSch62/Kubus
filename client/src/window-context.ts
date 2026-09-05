import type { AppWindowContext } from '@kubus/shared';
import { useClustersStore } from './state/clusters.js';
import { useUiPrefsStore } from './state/prefs.js';

/** Snapshot only the working context a new window needs to start in the same place. */
export function currentAppWindowContext(): AppWindowContext {
  const clusters = useClustersStore.getState();
  // Each selected cluster keeps its own namespace filter; the union alone
  // would hand every cluster the namespaces of the others.
  const namespacesByContext = Object.fromEntries(clusters.selected.flatMap((ctx) => (clusters.namespacesByContext[ctx]?.length ? [[ctx, [...clusters.namespacesByContext[ctx]!]]] : [])));
  return {
    selected: [...clusters.selected],
    namespaces: [...clusters.namespaces],
    namespacesByContext,
    navCollapsed: useUiPrefsStore.getState().navCollapsed,
  };
}

/** Apply a launch snapshot once; subsequent changes remain local to this window. */
export function applyAppWindowContext(context: AppWindowContext): void {
  const clusters = useClustersStore.getState();
  clusters.setSelected([...context.selected]);
  if (context.namespacesByContext) {
    for (const ctx of context.selected) clusters.setNamespaces([...(context.namespacesByContext[ctx] ?? [])], [ctx]);
  } else {
    clusters.setNamespaces([...context.namespaces], [...context.selected]);
  }
  useUiPrefsStore.getState().set({ navCollapsed: context.navCollapsed });
}
