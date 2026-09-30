import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

export type EventsScope = 'warnings' | 'all';
export type EventsGrouping = 'object' | 'flat';

interface EventsPrefsState {
  /** Every event (the default) or warnings only. */
  scope: EventsScope;
  /** One row per involved object (the default), or the flat event log, newest first. */
  grouping: EventsGrouping;
  setScope: (scope: EventsScope) => void;
  setGrouping: (grouping: EventsGrouping) => void;
}

export const useEventsPrefsStore = create<EventsPrefsState>()(
  persist(
    (set) => ({
      scope: 'all',
      grouping: 'object',
      setScope: (scope) => set({ scope }),
      setGrouping: (grouping) => set({ grouping }),
    }),
    {
      name: 'kubus-events-view',
      version: 1,
      storage: createJSONStorage(() => kubusStateStorage),
      // Version 0 opened on warnings only by default, and the store may have
      // written that default without anyone choosing it.
      migrate: (persisted, version) => {
        const state = persisted as Partial<EventsPrefsState>;
        if (version === 0) return { ...state, scope: 'all' };
        return state;
      },
    },
  ),
);
