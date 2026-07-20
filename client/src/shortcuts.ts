import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { MOD_KEY_LABEL } from './platform.js';
import { isEditorOrTerminalTarget, isTextEntryTarget } from './text-entry.js';
import { NAV_OVERLAY_MEDIA_QUERY, useNavUiStore } from './state/nav-ui.js';
import { useUiPrefsStore } from './state/prefs.js';
import { useUiStore } from './state/ui.js';
import { useTabsStore } from './state/tabs.js';
import { useDockStore } from './state/dock.js';
import { useDetailStore } from './state/detail.js';

/** How long a pending `g` waits for its second key (the which-key panel shows meanwhile). */
export const GO_TIMEOUT_MS = 3000;

/** `g` sequences: press g, then one of these keys, to jump to a page. */
export const GO_TARGETS: Array<{ key: string; path: string; label: string }> = [
  { key: 'o', path: '/', label: 'Overview' },
  { key: 'p', path: '/r/core/v1/pods', label: 'Pods' },
  { key: 'd', path: '/r/apps/v1/deployments', label: 'Deployments' },
  { key: 's', path: '/r/core/v1/services', label: 'Services' },
  { key: 'n', path: '/r/core/v1/nodes', label: 'Nodes' },
  { key: 'i', path: '/r/networking.k8s.io/v1/ingresses', label: 'Ingresses' },
  { key: 'c', path: '/r/core/v1/configmaps', label: 'ConfigMaps' },
  { key: 'k', path: '/r/core/v1/secrets', label: 'Secrets' },
  { key: 'e', path: '/events', label: 'Events' },
  { key: 'h', path: '/helm', label: 'Helm releases' },
  { key: 't', path: '/topology', label: 'Topology' },
  { key: 'm', path: '/metrics', label: 'Metrics' },
  { key: 'w', path: '/network', label: 'Network' },
  { key: 'f', path: '/forwards', label: 'Port forwards' },
  { key: 'a', path: '/audit', label: 'Audit' },
];

/** Wide viewports toggle the pinned rail; narrow ones the overlay drawer. */
export function toggleNavRail(): void {
  if (window.matchMedia(NAV_OVERLAY_MEDIA_QUERY).matches) {
    const nav = useNavUiStore.getState();
    nav.setOverlayOpen(!nav.overlayOpen);
  } else {
    const prefs = useUiPrefsStore.getState();
    prefs.set({ navCollapsed: !prefs.navCollapsed });
  }
}

export interface ShortcutRowDef {
  /** Alternative key combos, each an array of keys pressed together. */
  combos: string[][];
  description: string;
  /** The combo's keys are pressed one after another (rendered "G then P"), not as a chord. */
  sequence?: boolean;
  /** Shown only in the desktop app (the chord needs the Electron main process). */
  desktopOnly?: boolean;
  /** Shown only in the browser (the desktop app has a native equivalent). */
  webOnly?: boolean;
}

const MOD = MOD_KEY_LABEL;

/** Single source of truth for the cheatsheet — every binding below is wired here or next to its owner. */
export const SHORTCUT_SECTIONS: Array<{ title: string; shortcuts: ShortcutRowDef[] }> = [
  {
    title: 'Global',
    shortcuts: [
      { combos: [[MOD, 'K']], description: 'Command palette (toggle)' },
      { combos: [['?']], description: 'Keyboard shortcuts (this dialog)' },
      { combos: [[MOD, 'B']], description: 'Toggle the navigation rail' },
      { combos: [[MOD, 'J']], description: 'Toggle the terminal / logs dock' },
      { combos: [[MOD, ',']], description: 'Open settings' },
      { combos: [[MOD, '1–9']], description: 'Open pinned favorite 1–9' },
      { combos: [['Esc']], description: 'Close dialogs & menus · close the details panel · restore a maximized dock' },
    ],
  },
  {
    title: 'Tabs',
    shortcuts: [
      { combos: [['Alt', 'T']], description: 'New tab' },
      { combos: [['Alt', 'W']], description: 'Close the focused dock or page tab' },
      { combos: [[MOD, 'W']], description: 'Close the focused dock or page tab', desktopOnly: true },
      { combos: [['Alt', 'Shift', 'T']], description: 'Reopen the last closed tab' },
      { combos: [['Alt', '1–9']], description: 'Switch to tab 1–9 (9 = last tab)' },
      { combos: [['Alt', 'PgUp'], ['Alt', 'PgDn']], description: 'Previous / next tab' },
      { combos: [['Ctrl', 'Tab'], ['Ctrl', 'Shift', 'Tab']], description: 'Next / previous tab', desktopOnly: true },
      { combos: [['←'], ['→'], ['Home'], ['End']], description: 'Move focus on the tab strip' },
      { combos: [['Enter'], ['Delete']], description: 'Activate / close the focused tab' },
      { combos: [[MOD, 'Click'], ['Middle-click']], description: 'Open a link in a background tab' },
      { combos: [['Middle-click']], description: 'Close a tab (on the tab strip)' },
    ],
  },
  {
    title: 'Go to',
    shortcuts: GO_TARGETS.map((t) => ({ combos: [['G', t.key.toUpperCase()]], sequence: true, description: t.label })),
  },
  {
    title: 'Command palette',
    shortcuts: [
      { combos: [['↑'], ['↓']], description: 'Move selection' },
      { combos: [['PgUp'], ['PgDn']], description: 'Move selection a page at a time' },
      { combos: [['Enter']], description: 'Open the selected result' },
      { combos: [[MOD, 'Enter']], description: 'Open in a new tab' },
      { combos: [['Shift', 'Enter']], description: 'Open in a background tab' },
      { combos: [['Tab'], ['→']], description: 'Show actions for the selected resource' },
      { combos: [['Esc'], ['Backspace'], ['←']], description: 'Leave the actions list' },
    ],
  },
  {
    title: 'Cluster picker',
    shortcuts: [
      { combos: [['↑'], ['↓']], description: 'Move selection (grid: also ← →)' },
      { combos: [['Enter']], description: 'Switch to the highlighted cluster' },
      { combos: [['Space'], [MOD, 'Enter']], description: 'Toggle the highlighted cluster (multi-select)' },
      { combos: [[MOD, 'A']], description: 'Select all shown contexts (with an empty search)' },
      { combos: [['Alt', '↑'], ['Alt', '↓']], description: 'Move the highlighted context (reorder / change group)' },
      { combos: [['Esc']], description: 'Clear the search, then close' },
    ],
  },
  {
    title: 'Resource lists',
    shortcuts: [
      { combos: [['S'], ['/'], [':']], description: 'Focus the filter input' },
      { combos: [[MOD, 'F']], description: 'Focus the filter input' },
      { combos: [['C']], description: 'Create a resource' },
      { combos: [[MOD, 'C']], description: 'Copy the focused cell' },
      { combos: [['Enter']], description: 'Open details for the focused row' },
      { combos: [['Right-click'], ['Shift', 'F10']], description: 'Open the row actions menu' },
      { combos: [['Esc']], description: 'In the filter: clear, then leave · elsewhere: close the details panel' },
    ],
  },
  {
    title: 'Details panel',
    shortcuts: [
      { combos: [['Esc']], description: 'Close the panel (focus returns to the list)' },
      { combos: [['Alt', '←']], description: 'Back to the previous resource in the panel' },
    ],
  },
  {
    title: 'Logs',
    shortcuts: [
      { combos: [[MOD, 'F']], description: 'Focus find' },
      { combos: [['Enter'], ['Shift', 'Enter']], description: 'Next / previous match' },
      { combos: [['Esc']], description: 'Clear find / filter, then leave it' },
    ],
  },
];

/**
 * The app-wide keyboard owner, mounted once in AppShell. Two window listeners:
 *
 * - capture phase: chords (mod-key, Alt tab chords) and `g` go-to sequences.
 *   Capture lets them win over page-level listeners, which all check
 *   `defaultPrevented`.
 * - bubble phase: the Escape dismiss chain. Bubble so focused surfaces
 *   (dialogs, menus, the palette's action stage, the details panel, editors,
 *   terminals) always get first refusal — MUI modals stop propagation, text
 *   surfaces are guarded explicitly.
 *
 * Also owns the desktop (Electron) tab chords: Cmd/Ctrl+W close and
 * Ctrl+Tab cycling arrive over IPC and reuse the same tab helpers.
 */
export function GlobalShortcuts() {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;

  useEffect(() => {
    // After any tab-store mutation, land the router on the (new) active tab —
    // the same store→router sync TabsBar does for its mouse interactions.
    // Compare against window.location, not useLocation: navigate() is
    // transition-wrapped, so React's location lags — a second chord arriving
    // mid-transition would otherwise see the stale URL and skip navigating.
    const landOnActiveTab = () => {
      const s = useTabsStore.getState();
      const active = s.tabs.find((t) => t.id === s.activeId);
      if (active && active.path !== window.location.pathname + window.location.search) void navRef.current(active.path);
    };

    const cycleTab = (delta: number) => {
      const s = useTabsStore.getState();
      if (s.tabs.length < 2) return;
      const idx = Math.max(0, s.tabs.findIndex((t) => t.id === s.activeId));
      s.setActive(s.tabs[(idx + delta + s.tabs.length) % s.tabs.length]!.id);
      landOnActiveTab();
    };

    const activateTab = (digit: number) => {
      const s = useTabsStore.getState();
      const tab = digit === 9 ? s.tabs.at(-1) : s.tabs[digit - 1];
      if (!tab) return;
      s.setActive(tab.id);
      landOnActiveTab();
    };

    const reopenTab = () => {
      const before = useTabsStore.getState().activeId;
      useTabsStore.getState().reopenTab();
      if (useTabsStore.getState().activeId !== before) landOnActiveTab();
    };

    // Same semantics as the desktop Cmd/Ctrl+W chord: a dock tab first, then
    // the active page tab — but never the last remaining page tab.
    const closeActiveTab = () => {
      const dock = useDockStore.getState();
      if (dock.open && dock.activeId) {
        dock.closeTab(dock.activeId);
        return;
      }
      const pages = useTabsStore.getState();
      if (pages.tabs.length > 1 && pages.activeId) {
        pages.closeTab(pages.activeId);
        landOnActiveTab();
      }
    };

    const onCapture = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && !e.altKey && !e.shiftKey) {
        if (key === 'k') {
          e.preventDefault();
          const ui = useUiStore.getState();
          ui.setSearchOpen(!ui.searchOpen);
          return;
        }
        if (key === 'b') {
          e.preventDefault();
          toggleNavRail();
          return;
        }
        // Guarded: in a shell Ctrl+J is a real control character (linefeed).
        if (key === 'j' && !isTextEntryTarget(e.target)) {
          e.preventDefault();
          const dock = useDockStore.getState();
          if (dock.tabs.length) dock.setOpen(!dock.open);
          return;
        }
        if (e.key === ',' && !isTextEntryTarget(e.target)) {
          e.preventDefault();
          useUiStore.getState().setSettingsOpen(true);
        }
        return;
      }

      // Alt is the tab namespace. Never with Ctrl/Meta (AltGr reports
      // ctrl+alt on Windows), and never while a terminal/editor owns Alt
      // sequences (Alt+digit is an escape sequence in shells).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !isEditorOrTerminalTarget(e.target)) {
        const digit = e.shiftKey ? undefined : /^Digit([1-9])$/.exec(e.code)?.[1];
        if (digit) {
          e.preventDefault();
          activateTab(Number(digit));
          return;
        }
        if (!e.shiftKey && e.code === 'PageDown') {
          e.preventDefault();
          cycleTab(1);
          return;
        }
        if (!e.shiftKey && e.code === 'PageUp') {
          e.preventDefault();
          cycleTab(-1);
          return;
        }
        if (e.code === 'KeyT') {
          e.preventDefault();
          if (e.shiftKey) {
            reopenTab();
          } else {
            useTabsStore.getState().openTab('/');
            landOnActiveTab();
          }
          return;
        }
        if (!e.shiftKey && e.code === 'KeyW') {
          e.preventDefault();
          closeActiveTab();
        }
        return;
      }

      if (mod || e.altKey) return;

      if (isTextEntryTarget(e.target)) return;

      // `g` go-to sequences (pending state lives in the ui store so the
      // which-key panel can render it). An unmatched second key cancels and
      // falls through to whoever else wants it (e.g. `?` or `s`).
      const ui = useUiStore.getState();
      if (ui.goPendingSince && Date.now() - ui.goPendingSince < GO_TIMEOUT_MS) {
        ui.clearGoPending();
        const target = e.shiftKey ? undefined : GO_TARGETS.find((t) => t.key === key);
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          void navRef.current(target.path);
          return;
        }
      }

      if (e.key === '?') {
        e.preventDefault();
        useUiStore.getState().setShortcutsOpen(true);
        return;
      }

      if (key === 'g' && !e.shiftKey) useUiStore.getState().startGoPending();
    };

    const onBubble = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      useUiStore.getState().clearGoPending();
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Inputs, dialogs, menus, editors, and terminals own their Escape.
      if (isTextEntryTarget(e.target)) return;

      // Dismiss chain, topmost surface first.
      const navUi = useNavUiStore.getState();
      if (navUi.overlayOpen) {
        navUi.setOverlayOpen(false);
        return;
      }
      const dock = useDockStore.getState();
      if (dock.maximized) {
        dock.setMaximized(false);
        return;
      }
      const detail = useDetailStore.getState();
      if (detail.stack.length) {
        detail.close();
        // Drop the ?sel deep link so the tab doesn't reopen the selection.
        const { pathname, search } = window.location;
        const params = new URLSearchParams(search);
        if (params.has('sel')) {
          params.delete('sel');
          void navRef.current({ pathname, search: params.toString() }, { replace: true });
        }
        // Hand focus to the visible list's grid so arrow keys keep working.
        requestAnimationFrame(() => {
          const page = [...document.querySelectorAll<HTMLElement>('.kubus-resource-page')].find((el) => !el.closest('[aria-hidden="true"]'));
          const cell =
            page?.querySelector<HTMLElement>('.MuiDataGrid-cell[tabindex="0"], .MuiDataGrid-columnHeader[tabindex="0"]') ??
            page?.querySelector<HTMLElement>('.MuiDataGrid-cell');
          cell?.focus();
        });
      }
    };

    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    const desktop = window.kubusDesktop;
    const offClose = desktop?.onCloseTab?.(closeActiveTab);
    const offCycle = desktop?.onCycleTab?.((backwards) => cycleTab(backwards ? -1 : 1));
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
      offClose?.();
      offCycle?.();
    };
  }, []);

  return null;
}
