import { create } from 'zustand';

/**
 * Transient top-level dialog state (command palette, settings, shortcut
 * cheatsheet) — shared so the top-bar buttons, the command palette, and the
 * global keyboard shortcuts all drive the same dialogs.
 */
interface UiState {
  searchOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  /** When a `g` go-to sequence is pending: its Date.now() start; 0 = none. Drives the which-key panel. */
  goPendingSince: number;
  setSearchOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  startGoPending: () => void;
  clearGoPending: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  searchOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  goPendingSince: 0,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  startGoPending: () => set({ goPendingSince: Date.now() }),
  clearGoPending: () => set((s) => (s.goPendingSince ? { goPendingSince: 0 } : s)),
}));
