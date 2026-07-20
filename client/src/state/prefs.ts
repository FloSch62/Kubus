import { useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

export type TableDensity = 'compact' | 'comfortable';
export type RefreshRate = 'fast' | 'normal' | 'slow' | 'off';
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
  /** Treat contexts without an explicit protected flag as protected. */
  protectByDefault: boolean;
  /** Nav rail collapsed to reclaim width (wide viewports only). */
  navCollapsed: boolean;
  /** Overview "high usage" pod panel: usage ≥ this % of the limit. */
  highUsagePct: number;
  /** Overview "under-requested" pod panel: usage ≥ this multiple of the request. */
  underRequestedFactor: number;
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
      protectByDefault: false,
      navCollapsed: false,
      highUsagePct: 80,
      underRequestedFactor: 2,
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
    { name: 'kubus-prefs', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);

/**
 * Scale a polled query's base interval by the user's refresh-rate preset.
 * A stable per-mount ±10% jitter decorrelates the timers of components that
 * poll with the same base (e.g. one overview section per cluster), so many
 * clusters don't fire synchronized request bursts.
 */
export function useRefetchInterval(base: number): number | false {
  const rate = useUiPrefsStore((s) => s.refreshRate);
  const [jitter] = useState(() => 0.9 + Math.random() * 0.2);
  return rate === 'off' ? false : Math.round(base * REFRESH_FACTOR[rate] * jitter);
}
