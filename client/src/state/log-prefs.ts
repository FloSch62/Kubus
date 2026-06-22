import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TsMode = 'off' | 'local' | 'utc';

interface LogPrefsState {
  wrap: boolean;
  tsMode: TsMode;
  highlight: boolean;
  setWrap: (wrap: boolean) => void;
  cycleTsMode: () => void;
  setTsMode: (tsMode: TsMode) => void;
  setHighlight: (highlight: boolean) => void;
}

const TS_CYCLE: Record<TsMode, TsMode> = { off: 'local', local: 'utc', utc: 'off' };

export const useLogPrefsStore = create<LogPrefsState>()(
  persist(
    (set) => ({
      wrap: false,
      tsMode: 'off',
      highlight: true,
      setWrap: (wrap) => set({ wrap }),
      cycleTsMode: () => set((s) => ({ tsMode: TS_CYCLE[s.tsMode] })),
      setTsMode: (tsMode) => set({ tsMode }),
      setHighlight: (highlight) => set({ highlight }),
    }),
    { name: 'kubus-log-prefs' },
  ),
);
