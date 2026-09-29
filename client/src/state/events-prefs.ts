import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kubusStateStorage } from './persist-storage.js';

export type EventsScope = 'warnings' | 'all';
export type EventsGrouping = 'object' | 'flat';

interface EventsPrefsState {
  /** Warnings only (the default) or every event. */
  scope: EventsScope;
  /** One row per involved object (the default) or the flat event log. */
  grouping: EventsGrouping;
  setScope: (scope: EventsScope) => void;
  setGrouping: (grouping: EventsGrouping) => void;
}

export const useEventsPrefsStore = create<EventsPrefsState>()(
  persist(
    (set) => ({
      scope: 'warnings',
      grouping: 'object',
      setScope: (scope) => set({ scope }),
      setGrouping: (grouping) => set({ grouping }),
    }),
    { name: 'kubus-events-view', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);
