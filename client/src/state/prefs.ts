import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  set: (patch: Partial<Omit<UiPrefsState, 'set'>>) => void;
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
      set: (patch) => set(patch),
    }),
    { name: 'kubus-prefs' },
  ),
);

/** Scale a polled query's base interval by the user's refresh-rate preset. */
export function useRefetchInterval(base: number): number | false {
  const rate = useUiPrefsStore((s) => s.refreshRate);
  return rate === 'off' ? false : base * REFRESH_FACTOR[rate];
}
