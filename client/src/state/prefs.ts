import { useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { usePaneActive } from '../layout/pane-context.js';
import { kubusStateStorage, skipUnchangedStorageWrites } from './persist-storage.js';
import { windowScopeId } from '../window-management.js';

export type TableDensity = 'compact' | 'comfortable';
export type RefreshRate = 'fast' | 'normal' | 'slow' | 'off';
export type RightClickAction = 'copy-paste' | 'paste' | 'menu';
export const TAIL_LINE_OPTIONS = [100, 500, 1000, 5000] as const;

const REFRESH_FACTOR: Record<Exclude<RefreshRate, 'off'>, number> = { fast: 0.5, normal: 1, slow: 2 };

interface UiPrefsState {
  tableDensity: TableDensity;
  /** Base font size for monospace surfaces (logs, YAML editor, diff, terminal). */
  monoFontSize: number;
  /** Multiplier preset applied to all polled query intervals. */
  refreshRate: RefreshRate;
  /** Tail lines requested when opening a log view. */
  defaultTailLines: number;
  /** Exec shell: 'auto' lets the server pick bash-or-sh; anything else is sent verbatim. */
  defaultShell: string;
  /** Copy terminal text to the clipboard as soon as it is selected. */
  copyOnSelect: boolean;
  /** Right-click behavior in embedded terminals. */
  rightClickAction: RightClickAction;
  /** Treat contexts without an explicit protected flag as protected. */
  protectByDefault: boolean;
  /** Nav rail collapsed to reclaim width (wide viewports only). */
  navCollapsed: boolean;
  /** CronJob schedule columns show human-readable text instead of the cron expression. */
  cronHumanSchedule: boolean;
  /** Overview "high usage" pod panel: usage ≥ this % of the limit. */
  highUsagePct: number;
  /** Overview "under-requested" pod panel: usage ≥ this multiple of the request. */
  underRequestedFactor: number;
  /** Verbose diagnostic logging plus access to the app log viewer and export. */
  debugMode: boolean;
  /** User-resized column widths, keyed by table id then column field. */
  columnWidths: Record<string, Record<string, number>>;
  /** User-toggled column visibility models, keyed by table id then column field. */
  columnVisibility: Record<string, Record<string, boolean>>;
  /** User-chosen sort, keyed by table id. */
  sortModels: Record<string, TableSortModel>;
  set: (patch: Partial<Omit<UiPrefsState, 'set'>>) => void;
  setColumnWidth: (tableId: string, field: string, width: number) => void;
  setColumnVisibility: (tableId: string, model: Record<string, boolean>) => void;
  setSortModel: (tableId: string, model: TableSortModel) => void;
  /** Replace a table with a saved snapshot; absent parts restore implicit defaults. */
  applyTableState: (
    tableId: string,
    state: { columnWidths?: Record<string, number>; columnVisibility?: Record<string, boolean>; sort?: TableSortModel },
  ) => void;
}

export type TableSortModel = ReadonlyArray<{ field: string; sort: 'asc' | 'desc' | null | undefined }>;

const sessionStateStorage: StateStorage = {
  getItem: (name) => sessionStorage.getItem(name),
  setItem: (name, value) => sessionStorage.setItem(name, value),
  removeItem: (name) => sessionStorage.removeItem(name),
};

const prefsWindowScope = windowScopeId();
const prefsWindowStorage = prefsWindowScope === 'main' ? kubusStateStorage : sessionStateStorage;
const prefsWindowKey = `kubus-window-ui:${prefsWindowScope}`;
const sharedPrefsStorage = skipUnchangedStorageWrites(kubusStateStorage);

function syncStorageValue(storage: StateStorage, name: string): string | null {
  const value = storage.getItem(name);
  return typeof value === 'string' || value === null ? value : null;
}

function storedNavCollapsed(): boolean {
  try {
    const scoped = JSON.parse(syncStorageValue(prefsWindowStorage, prefsWindowKey) ?? 'null') as { navCollapsed?: unknown } | null;
    if (typeof scoped?.navCollapsed === 'boolean') return scoped.navCollapsed;
    if (prefsWindowScope !== 'main') return false;
    const legacy = JSON.parse(syncStorageValue(kubusStateStorage, 'kubus-prefs') ?? 'null') as {
      state?: { navCollapsed?: unknown };
    } | null;
    return typeof legacy?.state?.navCollapsed === 'boolean' ? legacy.state.navCollapsed : false;
  } catch {
    return false;
  }
}

const initialNavCollapsed = storedNavCollapsed();

function replaceTableValue<T>(values: Record<string, T>, tableId: string, value: T | undefined): Record<string, T> {
  const next = { ...values };
  if (value === undefined) delete next[tableId];
  else next[tableId] = value;
  return next;
}

export const useUiPrefsStore = create<UiPrefsState>()(
  persist(
    (set) => ({
      tableDensity: 'compact',
      monoFontSize: 12,
      refreshRate: 'normal',
      defaultTailLines: 500,
      defaultShell: 'auto',
      copyOnSelect: false,
      rightClickAction: 'copy-paste',
      protectByDefault: false,
      navCollapsed: initialNavCollapsed,
      cronHumanSchedule: false,
      highUsagePct: 80,
      underRequestedFactor: 2,
      debugMode: false,
      columnWidths: {},
      columnVisibility: {},
      sortModels: {},
      set: (patch) => set(patch),
      setColumnWidth: (tableId, field, width) =>
        set((state) => ({
          columnWidths: { ...state.columnWidths, [tableId]: { ...state.columnWidths[tableId], [field]: width } },
        })),
      setColumnVisibility: (tableId, model) =>
        set((state) => ({
          columnVisibility: { ...state.columnVisibility, [tableId]: model },
        })),
      setSortModel: (tableId, model) =>
        set((state) => ({
          sortModels: { ...state.sortModels, [tableId]: model },
        })),
      applyTableState: (tableId, state) =>
        set((s) => ({
          columnWidths: replaceTableValue(s.columnWidths, tableId, state.columnWidths),
          columnVisibility: replaceTableValue(s.columnVisibility, tableId, state.columnVisibility),
          sortModels: replaceTableValue(s.sortModels, tableId, state.sort),
        })),
    }),
    {
      name: 'kubus-prefs',
      version: 0,
      storage: createJSONStorage(() => sharedPrefsStorage),
      partialize: (state) => ({
        tableDensity: state.tableDensity,
        monoFontSize: state.monoFontSize,
        refreshRate: state.refreshRate,
        defaultTailLines: state.defaultTailLines,
        defaultShell: state.defaultShell,
        copyOnSelect: state.copyOnSelect,
        rightClickAction: state.rightClickAction,
        protectByDefault: state.protectByDefault,
        cronHumanSchedule: state.cronHumanSchedule,
        highUsagePct: state.highUsagePct,
        underRequestedFactor: state.underRequestedFactor,
        debugMode: state.debugMode,
        columnWidths: state.columnWidths,
        columnVisibility: state.columnVisibility,
        sortModels: state.sortModels,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<UiPrefsState>),
        navCollapsed: current.navCollapsed,
      }),
    },
  ),
);

let lastNavCollapsed = useUiPrefsStore.getState().navCollapsed;

function persistWindowUiState(navCollapsed: boolean): void {
  try {
    prefsWindowStorage.setItem(prefsWindowKey, JSON.stringify({ navCollapsed }));
  } catch {
    /* a blocked/full session store must not break layout preferences */
  }
}

persistWindowUiState(lastNavCollapsed);
useUiPrefsStore.subscribe((state) => {
  if (state.navCollapsed === lastNavCollapsed) return;
  lastNavCollapsed = state.navCollapsed;
  persistWindowUiState(lastNavCollapsed);
});

/**
 * Scale a polled query's base interval by the user's refresh-rate preset.
 * A stable per-mount ±10% jitter decorrelates the timers of components that
 * poll with the same base (e.g. one overview section per cluster), so many
 * clusters don't fire synchronized request bursts.
 *
 * Polling pauses while the enclosing tab pane is hidden — pages stay mounted
 * in inactive panes, and without this every open tab keeps its full request
 * loop running. On reveal the poll resumes on its normal cadence (watches keep
 * lists current; polled extras catch up within one interval).
 */
export function useRefetchInterval(base: number): number | false {
  const rate = useUiPrefsStore((s) => s.refreshRate);
  const paneActive = usePaneActive();
  const [jitter] = useState(() => 0.9 + Math.random() * 0.2);
  if (!paneActive || rate === 'off') return false;
  return Math.round(base * REFRESH_FACTOR[rate] * jitter);
}
