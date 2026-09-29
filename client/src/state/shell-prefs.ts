import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

interface ShellPrefsState {
  /**
   * Nav groups the user opened (true) or closed (false) by hand. Groups not
   * listed follow their default; opening a group because the current page
   * lives in it is not a choice and is not remembered.
   */
  navGroups: Record<string, boolean>;
  /** The Settings tab last looked at, by label; the dialog reopens there. */
  settingsTab?: string;
  setNavGroup: (title: string, open: boolean) => void;
  setSettingsTab: (tab: string) => void;
}

export const useShellPrefsStore = create<ShellPrefsState>()(
  persist(
    (set) => ({
      navGroups: {},
      settingsTab: undefined,
      setNavGroup: (title, open) => set((state) => ({ navGroups: { ...state.navGroups, [title]: open } })),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
    }),
    {
      name: 'kubus-shell-prefs',
      version: 0,
      storage: createJSONStorage(() => kubusStateStorage),
      partialize: (state) => ({ navGroups: state.navGroups, settingsTab: state.settingsTab }),
    },
  ),
);
