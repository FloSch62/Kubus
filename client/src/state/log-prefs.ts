import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

export type TsMode = 'off' | 'local' | 'utc';

interface LogPrefsState {
  wrap: boolean;
  tsMode: TsMode;
  highlight: boolean;
  enabledContainersByWorkload: Record<string, string[]>;
  setWrap: (wrap: boolean) => void;
  cycleTsMode: () => void;
  setTsMode: (tsMode: TsMode) => void;
  setHighlight: (highlight: boolean) => void;
  rememberEnabledContainers: (workloadKey: string, containers: string[]) => void;
}

const TS_CYCLE: Record<TsMode, TsMode> = { off: 'local', local: 'utc', utc: 'off' };

export const useLogPrefsStore = create<LogPrefsState>()(
  persist(
    (set) => ({
      wrap: false,
      tsMode: 'off',
      highlight: true,
      enabledContainersByWorkload: {},
      setWrap: (wrap) => set({ wrap }),
      cycleTsMode: () => set((s) => ({ tsMode: TS_CYCLE[s.tsMode] })),
      setTsMode: (tsMode) => set({ tsMode }),
      setHighlight: (highlight) => set({ highlight }),
      rememberEnabledContainers: (workloadKey, containers) =>
        set((s) => ({
          enabledContainersByWorkload: {
            ...s.enabledContainersByWorkload,
            [workloadKey]: containers,
          },
        })),
    }),
    {
      name: 'kubus-log-prefs',
      version: 1,
      storage: createJSONStorage(() => kubusStateStorage),
      migrate: (persisted, version) => {
        const state = persisted as Partial<LogPrefsState>;
        if (version === 0) return { ...state, enabledContainersByWorkload: {} };
        return state;
      },
    },
  ),
);
