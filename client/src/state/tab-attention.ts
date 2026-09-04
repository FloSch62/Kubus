import { create } from 'zustand';

/**
 * Page tabs that need a look: the object a background tab shows turned
 * unhealthy since the tab was last active. Transient by design — a reload
 * starts clean, the same way a browser forgets which tabs pinged.
 */
interface TabAttentionState {
  attention: Record<string, { reason: string }>;
  mark: (tabId: string, reason: string) => void;
  clear: (tabId: string) => void;
}

export const useTabAttentionStore = create<TabAttentionState>((set) => ({
  attention: {},
  mark: (tabId, reason) =>
    set((s) => (s.attention[tabId]?.reason === reason ? s : { attention: { ...s.attention, [tabId]: { reason } } })),
  clear: (tabId) =>
    set((s) => {
      if (!s.attention[tabId]) return s;
      const attention = { ...s.attention };
      delete attention[tabId];
      return { attention };
    }),
}));
