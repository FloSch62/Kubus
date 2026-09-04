import type { AppWindowContext } from '@kubus/shared';
import { useClustersStore } from './state/clusters.js';
import { useUiPrefsStore } from './state/prefs.js';

/** Snapshot only the working context a new window needs to start in the same place. */
export function currentAppWindowContext(): AppWindowContext {
  const clusters = useClustersStore.getState();
  return {
    selected: [...clusters.selected],
    namespaces: [...clusters.namespaces],
    navCollapsed: useUiPrefsStore.getState().navCollapsed,
  };
}

/** Apply a launch snapshot once; subsequent changes remain local to this window. */
export function applyAppWindowContext(context: AppWindowContext): void {
  const clusters = useClustersStore.getState();
  clusters.setSelected([...context.selected]);
  clusters.setNamespaces([...context.namespaces], [...context.selected]);
  useUiPrefsStore.getState().set({ navCollapsed: context.navCollapsed });
}
