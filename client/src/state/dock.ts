import { create } from 'zustand';
import type { LogTargetKind } from '@kubus/shared';
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
  sources?: Array<{ pod: string; containers: string[] }>;
  target?: { kind: LogTargetKind; name: string };
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
  terminalFocusRequest?: { tabId: string; sequence: number };
  terminalReconnectRequests: Record<string, number>;
  addTab: (tab: DockTab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  setMaximized: (maximized: boolean) => void;
  requestTerminalFocus: (id: string) => void;
  requestTerminalReconnect: (id: string) => void;
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
  terminalFocusRequest: undefined,
  terminalReconnectRequests: {},
  addTab: (tab) => {
    // The detail drawer is modal and would cover the dock — close it so the
    // freshly opened terminal/log tab is actually visible.
    useDetailStore.getState().close();
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, open: true }));
  },
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const terminalReconnectRequests = { ...s.terminalReconnectRequests };
      delete terminalReconnectRequests[id];
      return {
        tabs,
        activeId: s.activeId === id ? tabs[tabs.length - 1]?.id : s.activeId,
        open: tabs.length > 0 ? s.open : false,
        maximized: tabs.length > 0 ? s.maximized : false,
        terminalFocusRequest: s.terminalFocusRequest?.tabId === id ? undefined : s.terminalFocusRequest,
        terminalReconnectRequests,
      };
    }),
  setActive: (id) => set({ activeId: id, open: true }),
  setOpen: (open) => set(open ? { open } : { open, maximized: false }),
  setHeight: (height) => set({ height: clampDockHeight(height) }),
  setMaximized: (maximized) => set({ maximized }),
  requestTerminalFocus: (id) =>
    set((s) => {
      const tab = s.tabs.find((candidate) => candidate.id === id);
      if (tab?.kind !== 'terminal' && tab?.kind !== 'node-shell') return s;
      return {
        activeId: id,
        open: true,
        terminalFocusRequest: {
          tabId: id,
          sequence: (s.terminalFocusRequest?.sequence ?? 0) + 1,
        },
      };
    }),
  requestTerminalReconnect: (id) =>
    set((s) => {
      const tab = s.tabs.find((candidate) => candidate.id === id);
      if (tab?.kind !== 'terminal' && tab?.kind !== 'node-shell') return s;
      return {
        terminalReconnectRequests: {
          ...s.terminalReconnectRequests,
          [id]: (s.terminalReconnectRequests[id] ?? 0) + 1,
        },
      };
    }),
}));
