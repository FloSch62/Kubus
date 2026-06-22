import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useUiPrefsStore } from './prefs.js';

export interface ContextSettings {
  /**
   * Destructive actions against this context require typing the resource name.
   * Stored per-browser and enforced in confirm dialogs only — raw API calls
   * bypass it, which is acceptable for a local single-user tool.
   */
  protected?: boolean;
}

interface ClustersState {
  /** Context names the user has connected (multi-select). */
  selected: string[];
  /** Namespace filter — empty means all namespaces. */
  namespaces: string[];
  themeMode: 'light' | 'dark';
  /** Per-context UI settings keyed by context name. */
  contextSettings: Record<string, ContextSettings>;
  setSelected: (selected: string[]) => void;
  toggleContext: (name: string) => void;
  setNamespaces: (namespaces: string[]) => void;
  toggleTheme: () => void;
  setContextSetting: (ctx: string, patch: ContextSettings) => void;
}

export const useClustersStore = create<ClustersState>()(
  persist(
    (set) => ({
      selected: [],
      namespaces: [],
      themeMode: window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark',
      contextSettings: {},
      setSelected: (selected) => set({ selected }),
      toggleContext: (name) =>
        set((s) => ({
          selected: s.selected.includes(name) ? s.selected.filter((n) => n !== name) : [...s.selected, name],
        })),
      setNamespaces: (namespaces) => set({ namespaces }),
      toggleTheme: () => set((s) => ({ themeMode: s.themeMode === 'dark' ? 'light' : 'dark' })),
      setContextSetting: (ctx, patch) =>
        set((s) => ({
          contextSettings: { ...s.contextSettings, [ctx]: { ...s.contextSettings[ctx], ...patch } },
        })),
    }),
    { name: 'kubus-clusters' },
  ),
);

export function useIsProtected(ctx: string): boolean {
  const explicit = useClustersStore((s) => s.contextSettings[ctx]?.protected);
  const protectByDefault = useUiPrefsStore((s) => s.protectByDefault);
  return explicit ?? protectByDefault;
}
