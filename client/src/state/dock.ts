import { create } from 'zustand';
import type { LogTargetKind } from '@kubus/shared';
import { useDetailStore } from './detail.js';
import { windowScopeId } from '../window-management.js';

export interface TerminalTab {
  kind: 'terminal';
  id: string;
  title: string;
  ctx: string;
  namespace: string;
  pod: string;
  container: string;
  pinned?: boolean;
  color?: string;
  /** Stable server-side shell identity used for renderer handoff. */
  terminalId?: string;
  /** Opaque source-window token until a live handoff completes. */
  transferId?: string;
  /** Serialized xterm history captured immediately before a handoff. */
  snapshot?: string;
}

export interface NodeShellTab {
  kind: 'node-shell';
  id: string;
  title: string;
  ctx: string;
  node: string;
  pinned?: boolean;
  color?: string;
  terminalId?: string;
  transferId?: string;
  snapshot?: string;
}

/**
 * A shell on the machine Kubus runs on, with KUBECONFIG pointed at the
 * cluster and namespace the tab shows. `follow` keeps it on whatever the
 * cluster switcher and namespace filter select.
 */
export interface LocalShellTab {
  kind: 'local-shell';
  id: string;
  title: string;
  ctx: string;
  namespace?: string;
  follow?: boolean;
  /** Set once the server reports whether the shell got a real pseudo-terminal. */
  pty?: boolean;
  /** Typed into the shell (and run) as soon as it is ready — "run this kubectl command here". */
  pendingCommand?: string;
  pinned?: boolean;
  color?: string;
  terminalId?: string;
  transferId?: string;
  snapshot?: string;
}

export type ShellTab = TerminalTab | NodeShellTab | LocalShellTab;

/** Tabs backed by an xterm session (pod exec, node shell, local shell). */
export function isShellTab(tab: DockTab | undefined): tab is ShellTab {
  return tab?.kind === 'terminal' || tab?.kind === 'node-shell' || tab?.kind === 'local-shell';
}

/** Dock tab title for a local shell: the context it points at, plus the namespace when one is set. */
export function localShellTitle(ctx: string, namespace: string | undefined): string {
  return `${ctx}${namespace ? ` · ${namespace}` : ''}`;
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
  pinned?: boolean;
  color?: string;
}

export type DockTab = TerminalTab | NodeShellTab | LocalShellTab | LogsTab;

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
  closeOthers: (id: string) => void;
  closeRight: (id: string) => void;
  duplicateTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  setColor: (id: string, color?: string) => void;
  moveTab: (from: number, to: number) => void;
  adoptTab: (tab: DockTab, targetId?: string, edge?: 'before' | 'after') => boolean;
  setTerminalSession: (id: string, terminalId?: string) => void;
  clearTransfer: (id: string) => void;
  /** Update a local shell's context, namespace, follow mode or pending command; the title follows. */
  setLocalShell: (id: string, patch: Partial<Pick<LocalShellTab, 'ctx' | 'namespace' | 'follow' | 'pty' | 'pendingCommand'>>) => void;
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

function pinnedCount(tabs: readonly DockTab[]): number {
  const firstUnpinned = tabs.findIndex((tab) => !tab.pinned);
  return firstUnpinned < 0 ? tabs.length : firstUnpinned;
}

function insertionIndex(tabs: readonly DockTab[], tab: DockTab, requested: number): number {
  const boundary = pinnedCount(tabs);
  return tab.pinned
    ? Math.max(0, Math.min(requested, boundary))
    : Math.max(boundary, Math.min(requested, tabs.length));
}

function duplicateDockTab(tab: DockTab): DockTab {
  const copy = { ...tab, id: dockTabId() } as DockTab;
  delete copy.pinned;
  if (isShellTab(copy)) {
    delete copy.terminalId;
    delete copy.transferId;
    delete copy.snapshot;
  }
  if (copy.kind === 'local-shell') delete copy.pendingCommand;
  return copy as DockTab;
}

interface PersistedDockState {
  tabs: DockTab[];
  activeId?: string;
  open: boolean;
  height: number;
  maximized: boolean;
}

const dockSessionKey = `kubus-dock:${windowScopeId()}`;

function restoredDockState(): PersistedDockState | undefined {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(dockSessionKey) ?? 'null') as Partial<PersistedDockState> | null;
    if (!parsed || !Array.isArray(parsed.tabs) || !parsed.tabs.every((tab) => tab && ['terminal', 'node-shell', 'local-shell', 'logs'].includes(tab.kind))) {
      return undefined;
    }
    const activeId = parsed.tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : parsed.tabs[0]?.id;
    return {
      tabs: parsed.tabs,
      activeId,
      open: !!parsed.open && parsed.tabs.length > 0,
      height: typeof parsed.height === 'number' ? clampDockHeight(parsed.height) : 320,
      maximized: !!parsed.maximized && parsed.tabs.length > 0,
    };
  } catch {
    return undefined;
  }
}

const restored = restoredDockState();

export const useDockStore = create<DockState>((set) => ({
  tabs: restored?.tabs ?? [],
  activeId: restored?.activeId,
  open: restored?.open ?? false,
  height: restored?.height ?? 320,
  maximized: restored?.maximized ?? false,
  terminalFocusRequest: undefined,
  terminalReconnectRequests: {},
  addTab: (tab) => {
    // The detail drawer is modal and would cover the dock — close it so the
    // freshly opened terminal/log tab is actually visible.
    useDetailStore.getState().close();
    set((s) => {
      const at = insertionIndex(s.tabs, tab, s.tabs.length);
      return { tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)], activeId: tab.id, open: true };
    });
  },
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((tab) => tab.id === id);
      if (idx < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      const terminalReconnectRequests = { ...s.terminalReconnectRequests };
      delete terminalReconnectRequests[id];
      return {
        tabs,
        activeId: s.activeId === id ? tabs[Math.min(idx, tabs.length - 1)]?.id : s.activeId,
        open: tabs.length > 0 ? s.open : false,
        maximized: tabs.length > 0 ? s.maximized : false,
        terminalFocusRequest: s.terminalFocusRequest?.tabId === id ? undefined : s.terminalFocusRequest,
        terminalReconnectRequests,
      };
    }),
  closeOthers: (id) =>
    set((s) => {
      if (!s.tabs.some((tab) => tab.id === id)) return s;
      const tabs = s.tabs.filter((tab) => tab.id === id || tab.pinned);
      const keptIds = new Set(tabs.map((tab) => tab.id));
      return {
        tabs,
        activeId: id,
        terminalReconnectRequests: Object.fromEntries(
          Object.entries(s.terminalReconnectRequests).filter(([tabId]) => keptIds.has(tabId)),
        ),
      };
    }),
  closeRight: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((tab) => tab.id === id);
      if (idx < 0) return s;
      const closingIds = new Set(s.tabs.slice(idx + 1).filter((tab) => !tab.pinned).map((tab) => tab.id));
      if (!closingIds.size) return s;
      const tabs = s.tabs.filter((tab) => !closingIds.has(tab.id));
      return {
        tabs,
        activeId: s.activeId && closingIds.has(s.activeId) ? id : s.activeId,
        terminalReconnectRequests: Object.fromEntries(
          Object.entries(s.terminalReconnectRequests).filter(([tabId]) => !closingIds.has(tabId)),
        ),
      };
    }),
  duplicateTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((tab) => tab.id === id);
      if (idx < 0) return s;
      const tab = duplicateDockTab(s.tabs[idx]!);
      const at = insertionIndex(s.tabs, tab, idx + 1);
      return { tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)], activeId: tab.id, open: true };
    }),
  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.id === id && title.trim() ? { ...tab, title: title.trim().slice(0, 200) } : tab)),
    })),
  setPinned: (id, pinned) =>
    set((s) => {
      const idx = s.tabs.findIndex((tab) => tab.id === id);
      if (idx < 0 || !!s.tabs[idx]!.pinned === pinned) return s;
      const tabs = [...s.tabs];
      const [source] = tabs.splice(idx, 1);
      const tab = { ...source!, pinned: pinned || undefined } as DockTab;
      tabs.splice(pinnedCount(tabs), 0, tab);
      return { tabs };
    }),
  setColor: (id, color) =>
    set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, color: color || undefined } : tab)) })),
  moveTab: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return s;
      if (!!s.tabs[from]!.pinned !== !!s.tabs[to]!.pinned) return s;
      const tabs = [...s.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(to, 0, tab!);
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
      return {
        tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)],
        activeId: tab.id,
        open: true,
      };
    });
    return adopted;
  },
  setTerminalSession: (id, terminalId) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.id === id && isShellTab(tab) ? { ...tab, terminalId } : tab)),
    })),
  clearTransfer: (id) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== id || !isShellTab(tab)) return tab;
        const next = { ...tab };
        delete next.transferId;
        delete next.snapshot;
        return next;
      }),
    })),
  setLocalShell: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (tab.id !== id || tab.kind !== 'local-shell') return tab;
        const next: LocalShellTab = { ...tab, ...patch };
        for (const key of ['namespace', 'pendingCommand'] as const) if (next[key] === undefined) delete next[key];
        next.title = localShellTitle(next.ctx, next.namespace);
        return next;
      }),
    })),
  setActive: (id) => set({ activeId: id, open: true }),
  setOpen: (open) => set(open ? { open } : { open, maximized: false }),
  setHeight: (height) => set({ height: clampDockHeight(height) }),
  setMaximized: (maximized) => set({ maximized }),
  requestTerminalFocus: (id) =>
    set((s) => {
      const tab = s.tabs.find((candidate) => candidate.id === id);
      if (!isShellTab(tab)) return s;
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
      if (!isShellTab(tab)) return s;
      return {
        terminalReconnectRequests: {
          ...s.terminalReconnectRequests,
          [id]: (s.terminalReconnectRequests[id] ?? 0) + 1,
        },
      };
    }),
}));

// Session storage survives a renderer reload but not an app/browser restart:
// exactly the lifetime of the server-side terminal reattach grace period.
useDockStore.subscribe((state) => {
  try {
    sessionStorage.setItem(
      dockSessionKey,
      JSON.stringify({
        tabs: state.tabs,
        activeId: state.activeId,
        open: state.open,
        height: state.height,
        maximized: state.maximized,
      } satisfies PersistedDockState),
    );
  } catch {
    /* unavailable/full session storage must never break tab interactions */
  }
});
