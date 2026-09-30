import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

interface OverviewPrefsState {
  /**
   * Clusters opened to their full section on the multi-cluster Overview.
   * The others show a one-line summary; a single cluster is always open.
   */
  expanded: Record<string, boolean>;
  setExpanded: (ctx: string, expanded: boolean) => void;
  setAllExpanded: (contexts: string[], expanded: boolean) => void;
}

export const useOverviewPrefsStore = create<OverviewPrefsState>()(
  persist(
    (set) => ({
      expanded: {},
      setExpanded: (ctx, expanded) => set((s) => ({ expanded: { ...s.expanded, [ctx]: expanded } })),
      setAllExpanded: (contexts, expanded) =>
        set((s) => ({ expanded: { ...s.expanded, ...Object.fromEntries(contexts.map((ctx) => [ctx, expanded])) } })),
    }),
    { name: 'kubus-overview-view', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);
