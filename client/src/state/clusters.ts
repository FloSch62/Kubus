import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { useUiPrefsStore } from './prefs.js';
import { kubusStateStorage, skipUnchangedStorageWrites } from './persist-storage.js';
import { windowScopeId } from '../window-management.js';

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
  /**
   * Effective namespace filter — the union of every selected cluster's own
   * selection; empty means all namespaces. Derived: never set directly.
   */
  namespaces: string[];
  /**
   * Namespace selection remembered per cluster. Switching from the dev
   * cluster (on `team-a`) to prod (on `payments`) brings each cluster's own
   * namespaces back; with several selected, the filter shows the union and
   * edits apply to every selected cluster.
   */
  namespacesByContext: Record<string, string[]>;
  /**
   * Contexts whose kubeconfig namespace has been offered as their initial
   * filter. A context is seeded once, the first time it is selected; after
   * that the user's own choice (including "all namespaces") sticks.
   */
  namespaceSeeded: string[];
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
  /** Set the namespace filter for the given clusters (default: every selected one). */
  setNamespaces: (namespaces: string[], contexts?: string[]) => void;
  /** Seed newly selected clusters' filters from their kubeconfig namespaces (see `namespaceSeeded`). */
  seedKubeconfigNamespaces: (contexts: KubeconfigNamespace[]) => void;
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

/** A kubeconfig context and the namespace it names, if any. */
export interface KubeconfigNamespace {
  name: string;
  namespace?: string;
}

/**
 * The first selection of a context adopts the namespace its kubeconfig entry
 * names, unless that cluster already has a filter of its own. Contexts are
 * marked seeded either way, so the kubeconfig never overrides a later choice.
 * Returns undefined when nothing changes.
 */
export function kubeconfigNamespaceSeed(
  state: Pick<ClustersState, 'selected' | 'namespaceSeeded' | 'namespacesByContext'>,
  contexts: KubeconfigNamespace[],
): Pick<ClustersState, 'namespaceSeeded' | 'namespacesByContext'> | undefined {
  const fresh = contexts.filter((c) => state.selected.includes(c.name) && !state.namespaceSeeded.includes(c.name));
  if (!fresh.length) return undefined;
  const namespacesByContext = { ...state.namespacesByContext };
  for (const c of fresh) {
    const namespace = c.namespace?.trim();
    if (namespace && !namespacesByContext[c.name]?.length) namespacesByContext[c.name] = [namespace];
  }
  return { namespaceSeeded: [...state.namespaceSeeded, ...fresh.map((c) => c.name)], namespacesByContext };
}

interface WindowClusterContext {
  selected: string[];
  namespaces: string[];
  namespacesByContext?: Record<string, string[]>;
}

/** The effective filter: the union of the selected clusters' namespaces, in first-seen order. */
export function namespacesForContexts(byContext: Record<string, string[]>, selected: string[]): string[] {
  const out: string[] = [];
  for (const ctx of selected) {
    for (const ns of byContext[ctx] ?? []) if (!out.includes(ns)) out.push(ns);
  }
  return out;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const sessionStateStorage: StateStorage = {
  getItem: (name) => sessionStorage.getItem(name),
  setItem: (name, value) => sessionStorage.setItem(name, value),
  removeItem: (name) => sessionStorage.removeItem(name),
};

const clusterWindowScope = windowScopeId();
const clusterWindowStorage = clusterWindowScope === 'main' ? kubusStateStorage : sessionStateStorage;
const clusterWindowKey = `kubus-window-clusters:${clusterWindowScope}`;
const sharedClusterStorage = skipUnchangedStorageWrites(kubusStateStorage);

function syncStorageValue(storage: StateStorage, name: string): string | null {
  const value = storage.getItem(name);
  return typeof value === 'string' || value === null ? value : null;
}

function parseWindowClusterContext(raw: string | null): WindowClusterContext | undefined {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<WindowClusterContext> | null;
    if (!value || !isStringList(value.selected) || !isStringList(value.namespaces)) return undefined;
    const byContext: Record<string, string[]> = {};
    if (value.namespacesByContext && typeof value.namespacesByContext === 'object') {
      for (const [ctx, list] of Object.entries(value.namespacesByContext)) if (isStringList(list)) byContext[ctx] = list;
    } else {
      // Older state stored one flat list: it applied to every selected cluster.
      for (const ctx of value.selected) byContext[ctx] = value.namespaces;
    }
    return { selected: value.selected, namespaces: namespacesForContexts(byContext, value.selected), namespacesByContext: byContext };
  } catch {
    return undefined;
  }
}

function legacyMainClusterContext(): WindowClusterContext | undefined {
  if (clusterWindowScope !== 'main') return undefined;
  try {
    const envelope = JSON.parse(syncStorageValue(kubusStateStorage, 'kubus-clusters') ?? 'null') as {
      state?: Partial<WindowClusterContext>;
    } | null;
    if (!envelope?.state) return undefined;
    return parseWindowClusterContext(JSON.stringify(envelope.state));
  } catch {
    return undefined;
  }
}

const initialWindowClusterContext =
  parseWindowClusterContext(syncStorageValue(clusterWindowStorage, clusterWindowKey)) ??
  legacyMainClusterContext() ??
  { selected: [], namespaces: [], namespacesByContext: {} };

export const useClustersStore = create<ClustersState>()(
  persist(
    (set) => ({
      selected: initialWindowClusterContext.selected,
      namespaces: initialWindowClusterContext.namespaces,
      namespacesByContext: initialWindowClusterContext.namespacesByContext ?? {},
      namespaceSeeded: [],
      themeMode: 'os',
      contextSettings: {},
      contextOrder: [],
      pickerLayout: 'list',
      setSelected: (selected) => set((s) => ({ selected, namespaces: namespacesForContexts(s.namespacesByContext, selected) })),
      toggleContext: (name) =>
        set((s) => {
          const selected = s.selected.includes(name) ? s.selected.filter((n) => n !== name) : [...s.selected, name];
          return { selected, namespaces: namespacesForContexts(s.namespacesByContext, selected) };
        }),
      setNamespaces: (namespaces, contexts) =>
        set((s) => {
          const byContext = { ...s.namespacesByContext };
          for (const ctx of contexts ?? s.selected) {
            if (namespaces.length) byContext[ctx] = [...namespaces];
            else delete byContext[ctx];
          }
          return { namespacesByContext: byContext, namespaces: namespacesForContexts(byContext, s.selected) };
        }),
      seedKubeconfigNamespaces: (contexts) =>
        set((s) => {
          const seed = kubeconfigNamespaceSeed(s, contexts);
          return seed ? { ...seed, namespaces: namespacesForContexts(seed.namespacesByContext, s.selected) } : s;
        }),
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
          const namespacesByContext = { ...s.namespacesByContext };
          delete namespacesByContext[name];
          const selected = s.selected.filter((n) => n !== name);
          return {
            selected,
            namespacesByContext,
            namespaceSeeded: s.namespaceSeeded.filter((n) => n !== name),
            namespaces: namespacesForContexts(namespacesByContext, selected),
            contextSettings,
            contextOrder: s.contextOrder.filter((n) => n !== name),
          };
        }),
    }),
    {
      name: 'kubus-clusters',
      version: 0,
      storage: createJSONStorage(() => sharedClusterStorage),
      // A window's active cluster/namespace context is deliberately absent:
      // rehydrating app-wide cluster metadata must not navigate other windows.
      partialize: ({ themeMode, contextSettings, contextOrder, pickerLayout, namespaceSeeded }) => ({
        themeMode,
        contextSettings,
        contextOrder,
        pickerLayout,
        namespaceSeeded,
      }),
      merge: (persisted, current) => {
        const stored = persisted as Partial<ClustersState> | undefined;
        return {
          ...current,
          ...stored,
          selected: current.selected,
          namespaces: current.namespaces,
          namespacesByContext: current.namespacesByContext,
          // State from before seeding existed: the clusters already open were
          // chosen by hand, so leave their filters alone.
          namespaceSeeded: stored ? (stored.namespaceSeeded ?? current.selected) : current.namespaceSeeded,
        };
      },
    },
  ),
);

let lastSelected = useClustersStore.getState().selected;
let lastNamespaces = useClustersStore.getState().namespaces;
let lastByContext = useClustersStore.getState().namespacesByContext;

function persistWindowClusterContext(selected: string[], namespaces: string[], namespacesByContext: Record<string, string[]>): void {
  try {
    clusterWindowStorage.setItem(clusterWindowKey, JSON.stringify({ selected, namespaces, namespacesByContext } satisfies WindowClusterContext));
  } catch {
    /* a blocked/full session store must not break cluster switching */
  }
}

persistWindowClusterContext(lastSelected, lastNamespaces, lastByContext);
useClustersStore.subscribe((state) => {
  if (state.selected === lastSelected && state.namespaces === lastNamespaces && state.namespacesByContext === lastByContext) return;
  lastSelected = state.selected;
  lastNamespaces = state.namespaces;
  lastByContext = state.namespacesByContext;
  persistWindowClusterContext(lastSelected, lastNamespaces, lastByContext);
});

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
