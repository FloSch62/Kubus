import { create } from 'zustand';
import { useDetailStore } from './detail.js';

export interface TerminalTab {
  kind: 'terminal';
  id: string;
  title: string;
  ctx: string;
  namespace: string;
  pod: string;
  container: string;
}

export interface NodeShellTab {
  kind: 'node-shell';
  id: string;
  title: string;
  ctx: string;
  node: string;
}

export interface LogsTab {
  kind: 'logs';
  id: string;
  title: string;
  ctx: string;
  namespace: string;
  pods: string[];
  container?: string;
  follow?: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  previous?: boolean;
}

export type DockTab = TerminalTab | NodeShellTab | LogsTab;

interface DockState {
  tabs: DockTab[];
  activeId?: string;
  open: boolean;
  height: number;
  maximized: boolean;
  addTab: (tab: DockTab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  setMaximized: (maximized: boolean) => void;
}

let counter = 0;
export function dockTabId(): string {
  return `dock-${++counter}-${Date.now().toString(36)}`;
}

export function clampDockHeight(height: number): number {
  return Math.max(160, Math.min(window.innerHeight - 200, height));
}

export const useDockStore = create<DockState>((set) => ({
  tabs: [],
  activeId: undefined,
  open: false,
  height: 320,
  maximized: false,
  addTab: (tab) => {
    // The detail drawer is modal and would cover the dock — close it so the
    // freshly opened terminal/log tab is actually visible.
    useDetailStore.getState().close();
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, open: true }));
  },
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeId: s.activeId === id ? tabs[tabs.length - 1]?.id : s.activeId,
        open: tabs.length > 0 ? s.open : false,
        maximized: tabs.length > 0 ? s.maximized : false,
      };
    }),
  setActive: (id) => set({ activeId: id, open: true }),
  setOpen: (open) => set(open ? { open } : { open, maximized: false }),
  setHeight: (height) => set({ height: clampDockHeight(height) }),
  setMaximized: (maximized) => set({ maximized }),
}));
