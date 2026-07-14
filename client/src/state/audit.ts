import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

interface AuditPrefsState {
  /** Check ids the user has dismissed — hidden from the report until restored. */
  dismissedChecks: string[];
  dismissCheck: (id: string) => void;
  restoreCheck: (id: string) => void;
}

export const useAuditPrefsStore = create<AuditPrefsState>()(
  persist(
    (set) => ({
      dismissedChecks: [],
      dismissCheck: (id) => set((s) => ({ dismissedChecks: s.dismissedChecks.includes(id) ? s.dismissedChecks : [...s.dismissedChecks, id] })),
      restoreCheck: (id) => set((s) => ({ dismissedChecks: s.dismissedChecks.filter((c) => c !== id) })),
    }),
    { name: 'kubus-audit', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);
