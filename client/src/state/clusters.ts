import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useUiPrefsStore } from './prefs.js';
import { kubusStateStorage } from './persist-storage.js';

export interface ContextSettings {
  /**
   * Destructive actions against this context require typing the resource name.
   * Stored per-browser and enforced in confirm dialogs only — raw API calls
   * bypass it, which is acceptable for a local single-user tool.
   */
  protected?: boolean;
  /** User-defined picker group (e.g. "prod", "team-a"); unset = ungrouped. */
  group?: string;
  /** Emoji shown next to the context in the picker and top bar. */
  icon?: string;
}

export type PickerLayout = 'list' | 'grid';

interface ClustersState {
  /** Context names the user has connected (multi-select). */
  selected: string[];
  /** Namespace filter — empty means all namespaces. */
  namespaces: string[];
  themeMode: 'light' | 'dark' | 'os';
  /** Per-context UI settings keyed by context name. */
  contextSettings: Record<string, ContextSettings>;
  /**
   * User-arranged picker order (context names). Contexts not listed sort
   * after, in kubeconfig order. Written as the full visible order on every
   * reorder so rendering and stored order never disagree.
   */
  contextOrder: string[];
  /** Cluster picker layout preference. */
  pickerLayout: PickerLayout;
  setSelected: (selected: string[]) => void;
  toggleContext: (name: string) => void;
  setNamespaces: (namespaces: string[]) => void;
  // Cycles light → dark → os → light
  toggleTheme: () => void;
  // setTheme directly sets the theme mode to any valid value ('light', 'dark', 'os')
  setTheme: (mode: 'light' | 'dark' | 'os') => void;
  setContextSetting: (ctx: string, patch: ContextSettings) => void;
  setContextOrder: (order: string[]) => void;
  setPickerLayout: (layout: PickerLayout) => void;
  /** Forget all client-side state for a context (after it was removed from the kubeconfig). */
  removeContext: (name: string) => void;
}

export const useClustersStore = create<ClustersState>()(
  persist(
    (set) => ({
      selected: [],
      namespaces: [],
      themeMode: 'os',
      contextSettings: {},
      contextOrder: [],
      pickerLayout: 'list',
      setSelected: (selected) => set({ selected }),
      toggleContext: (name) =>
        set((s) => ({
          selected: s.selected.includes(name) ? s.selected.filter((n) => n !== name) : [...s.selected, name],
        })),
      setNamespaces: (namespaces) => set({ namespaces }),
      //Ternary operator to cycle through three values: 'light' → 'dark' → 'os' → 'light'…
      toggleTheme: () => set((s) => ({ themeMode: s.themeMode === 'light' ? 'dark' : s.themeMode === 'dark' ? 'os' : 'light' })),
      setTheme: (mode) => set({ themeMode: mode }),
      setContextSetting: (ctx, patch) =>
        set((s) => ({
          contextSettings: { ...s.contextSettings, [ctx]: { ...s.contextSettings[ctx], ...patch } },
        })),
      setContextOrder: (contextOrder) => set({ contextOrder }),
      setPickerLayout: (pickerLayout) => set({ pickerLayout }),
      removeContext: (name) =>
        set((s) => {
          const contextSettings = { ...s.contextSettings };
          delete contextSettings[name];
          return {
            selected: s.selected.filter((n) => n !== name),
            contextSettings,
            contextOrder: s.contextOrder.filter((n) => n !== name),
          };
        }),
    }),
    { name: 'kubus-clusters', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);

export function useIsProtected(ctx: string): boolean {
  const explicit = useClustersStore((s) => s.contextSettings[ctx]?.protected);
  const protectByDefault = useUiPrefsStore((s) => s.protectByDefault);
  return explicit ?? protectByDefault;
}

/**
 * The one definition of what the global namespace filter means: an empty
 * selection shows everything, and cluster-scoped items (no namespace)
 * are always visible.
 */
export function namespaceVisible(namespace: string | undefined, selected: string[]): boolean {
  return selected.length === 0 || !namespace || selected.includes(namespace);
}
