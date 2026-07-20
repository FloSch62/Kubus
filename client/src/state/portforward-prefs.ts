import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

export interface ForwardTargetPref {
  /** Last explicitly chosen local port (auto picks are not remembered). */
  localPort?: number;
  openInBrowser?: boolean;
}

interface PortForwardPrefsState {
  byTarget: Record<string, ForwardTargetPref>;
  remember: (key: string, pref: ForwardTargetPref) => void;
}

export function forwardPrefKey(ctx: string, namespace: string, kind: string, name: string, remotePort: number): string {
  return `${ctx}/${namespace}/${kind}/${name}:${remotePort}`;
}

export const usePortForwardPrefsStore = create<PortForwardPrefsState>()(
  persist(
    (set) => ({
      byTarget: {},
      remember: (key, pref) =>
        set((s) => ({
          byTarget: { ...s.byTarget, [key]: { ...s.byTarget[key], ...pref } },
        })),
    }),
    {
      name: 'kubus-portforward-prefs',
      version: 1,
      storage: createJSONStorage(() => kubusStateStorage),
    },
  ),
);
