import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import type { SavedViewGridState } from '@kubus/shared';
import { kubusStateStorage } from './persist-storage.js';
import { windowScopeId } from '../window-management.js';

export interface PageTab {
  id: string;
  /** In-app location the tab shows: pathname + search (e.g. '/r/core/v1/pods?q=web'). */
  path: string;
  /** Saved-view state waiting to be applied the first time this tab is activated. */
  pendingSavedView?: SavedViewGridState;
  /** Optional user label; route-derived metadata remains the fallback. */
  customTitle?: string;
  pinned?: boolean;
  color?: string;
}

interface TabsState {
  tabs: PageTab[];
  activeId?: string;
  /** Paths of recently closed tabs, oldest first; feeds "reopen closed tab". */
  closedPaths: string[];
  openTab: (path: string, opts?: { activate?: boolean; afterActive?: boolean; pendingSavedView?: SavedViewGridState }) => void;
  clearPendingSavedView: (id: string) => void;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  closeRight: (id: string) => void;
  duplicateTab: (id: string) => void;
  renameTab: (id: string, title?: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  setColor: (id: string, color?: string) => void;
  /** Restore the most recently closed tab (after the active one) and activate it. */
  reopenTab: () => void;
  setActive: (id: string) => void;
  moveTab: (from: number, to: number) => void;
  /** Adopt an existing identity received from another window. */
  adoptTab: (tab: PageTab, targetId?: string, edge?: 'before' | 'after') => boolean;
  /** Mirror the router location into the active tab (creates the first tab). */
  syncLocation: (path: string) => void;
}

export function pageTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Trailing-debounced writes: the tab store updates on every in-tab navigation
 * (including per-keystroke filter changes), and each persist write is a
 * synchronous IPC call in the desktop app. Flushes on pagehide so the last
 * state survives app close.
 */
function debouncedStorage(base: StateStorage, ms: number): StateStorage {
  let pending: { name: string; value: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!pending) return;
    const { name, value } = pending;
    pending = undefined;
    base.setItem(name, value);
  };
  window.addEventListener('pagehide', flush);
  return {
    getItem: (name) => (pending?.name === name ? pending.value : base.getItem(name)),
    setItem: (name, value) => {
      pending = { name, value };
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, ms);
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = undefined;
      base.removeItem(name);
    },
  };
}

function freshTab(path: string, pendingSavedView?: SavedViewGridState): PageTab {
  return { id: pageTabId(), path, pendingSavedView };
}

function pinnedCount(tabs: readonly PageTab[]): number {
  return tabs.findIndex((tab) => !tab.pinned) < 0 ? tabs.length : tabs.findIndex((tab) => !tab.pinned);
}

function insertionIndex(tabs: readonly PageTab[], tab: PageTab, requested: number): number {
  const boundary = pinnedCount(tabs);
  return tab.pinned
    ? Math.max(0, Math.min(requested, boundary))
    : Math.max(boundary, Math.min(requested, tabs.length));
}

function recordClosed(closedPaths: string[], ...paths: string[]): string[] {
  return [...closedPaths, ...paths].slice(-10);
}

const initialTab = freshTab('/');
const scopeId = windowScopeId();
const tabsStorageName = scopeId === 'main' ? 'kubus-tabs' : `kubus-tabs:${scopeId}`;

export const useTabsStore = create<TabsState>()(
  persist(
    (set) => ({
      tabs: [initialTab],
      activeId: initialTab.id,
      closedPaths: [],
      openTab: (path, opts) =>
        set((s) => {
          const tab = freshTab(path, opts?.pendingSavedView);
          const activeIdx = s.tabs.findIndex((t) => t.id === s.activeId);
          const requested = opts?.afterActive && activeIdx >= 0 ? activeIdx + 1 : s.tabs.length;
          const at = insertionIndex(s.tabs, tab, requested);
          return {
            tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)],
            activeId: opts?.activate === false ? s.activeId : tab.id,
          };
        }),
      clearPendingSavedView: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((tab) => tab.id === id);
          if (idx < 0 || !s.tabs[idx]!.pendingSavedView) return s;
          const tabs = [...s.tabs];
          const tab = { ...tabs[idx]! };
          delete tab.pendingSavedView;
          tabs[idx] = tab;
          return { tabs };
        }),
      closeTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx < 0) return s;
          const closedPaths = recordClosed(s.closedPaths, s.tabs[idx]!.path);
          const tabs = s.tabs.filter((t) => t.id !== id);
          // The bar always shows at least one tab; closing the last one resets it.
          if (tabs.length === 0) {
            const tab = freshTab('/');
            return { tabs: [tab], activeId: tab.id, closedPaths };
          }
          // Like browsers: closing the active tab activates its right neighbor.
          const activeId = s.activeId === id ? tabs[Math.min(idx, tabs.length - 1)]!.id : s.activeId;
          return { tabs, activeId, closedPaths };
        }),
      closeOthers: (id) =>
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          const closing = s.tabs.filter((t) => t.id !== id && !t.pinned);
          const tabs = s.tabs.filter((t) => t.id === id || t.pinned);
          const closedPaths = recordClosed(s.closedPaths, ...closing.map((t) => t.path));
          return { tabs, activeId: id, closedPaths };
        }),
      closeRight: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx < 0) return s;
          const closing = s.tabs.slice(idx + 1).filter((tab) => !tab.pinned);
          const closingIds = new Set(closing.map((tab) => tab.id));
          const closedPaths = recordClosed(s.closedPaths, ...closing.map((t) => t.path));
          const tabs = s.tabs.filter((tab) => !closingIds.has(tab.id));
          const activeId = tabs.some((t) => t.id === s.activeId) ? s.activeId : id;
          return { tabs, activeId, closedPaths };
        }),
      reopenTab: () =>
        set((s) => {
          const path = s.closedPaths.at(-1);
          if (path === undefined) return s;
          const tab = freshTab(path);
          const activeIdx = s.tabs.findIndex((t) => t.id === s.activeId);
          const requested = activeIdx >= 0 ? activeIdx + 1 : s.tabs.length;
          const at = insertionIndex(s.tabs, tab, requested);
          return {
            closedPaths: s.closedPaths.slice(0, -1),
            tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)],
            activeId: tab.id,
          };
        }),
      duplicateTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx < 0) return s;
          const source = s.tabs[idx]!;
          const tab = { ...freshTab(source.path, source.pendingSavedView), customTitle: source.customTitle, color: source.color };
          const at = insertionIndex(s.tabs, tab, idx + 1);
          return { tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)], activeId: tab.id };
        }),
      renameTab: (id, title) =>
        set((s) => ({
          tabs: s.tabs.map((tab) =>
            tab.id === id ? { ...tab, customTitle: title?.trim().slice(0, 200) || undefined } : tab,
          ),
        })),
      setPinned: (id, pinned) =>
        set((s) => {
          const idx = s.tabs.findIndex((tab) => tab.id === id);
          if (idx < 0 || !!s.tabs[idx]!.pinned === pinned) return s;
          const tabs = [...s.tabs];
          const [source] = tabs.splice(idx, 1);
          const tab = { ...source!, pinned: pinned || undefined };
          const at = pinned ? pinnedCount(tabs) : pinnedCount(tabs);
          tabs.splice(at, 0, tab);
          return { tabs };
        }),
      setColor: (id, color) =>
        set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, color: color || undefined } : tab)) })),
      setActive: (id) => set({ activeId: id }),
      moveTab: (from, to) =>
        set((s) => {
          if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return s;
          if (!!s.tabs[from]!.pinned !== !!s.tabs[to]!.pinned) return s;
          const tabs = [...s.tabs];
          const [moved] = tabs.splice(from, 1);
          tabs.splice(to, 0, moved!);
          return { tabs };
        }),
      adoptTab: (tab, targetId, edge = 'after') => {
        let adopted = false;
        set((s) => {
          if (s.tabs.some((candidate) => candidate.id === tab.id)) return s;
          const targetIdx = targetId ? s.tabs.findIndex((candidate) => candidate.id === targetId) : s.tabs.length - 1;
          const requested = targetIdx < 0 ? s.tabs.length : targetIdx + (edge === 'after' ? 1 : 0);
          const at = insertionIndex(s.tabs, tab, requested);
          adopted = true;
          return { tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)], activeId: tab.id };
        });
        return adopted;
      },
      syncLocation: (path) =>
        set((s) => {
          // Fall back to the first tab if activeId is stale (e.g. corrupt persist).
          const active = s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];
          if (!active) {
            const tab = freshTab(path);
            return { tabs: [tab], activeId: tab.id };
          }
          if (active.path === path && s.activeId === active.id) return s;
          return { activeId: active.id, tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, path } : t)) };
        }),
    }),
    { name: tabsStorageName, version: 0, storage: createJSONStorage(() => debouncedStorage(kubusStateStorage, 250)) },
  ),
);
