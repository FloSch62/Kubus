import { useEffect } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ResourceRef } from '@kubus/shared';
import { kubusStateStorage } from './persist-storage.js';

/** How many recently opened resources the command palette remembers. */
export const RECENT_LIMIT = 8;

export interface RecentResource {
  /** Same id format as a search result, so favorites and recents dedupe. */
  id: string;
  ref: ResourceRef;
  /** Date.now() of the last open. */
  openedAt: number;
}

/** The search-result id of a resource (`resource:<ctx>:<g>/<v>/<plural>:<ns>:<name>`). */
export function resourceResultId(ref: Pick<ResourceRef, 'ctx' | 'group' | 'version' | 'plural' | 'namespace' | 'name'>): string {
  return `resource:${ref.ctx}:${ref.group}/${ref.version}/${ref.plural}:${ref.namespace ?? ''}:${ref.name}`;
}

interface RecentState {
  recent: RecentResource[];
  record: (ref: ResourceRef) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useRecentStore = create<RecentState>()(
  persist(
    (set) => ({
      recent: [],
      record: (ref) =>
        set((s) => {
          const id = resourceResultId(ref);
          // Re-opening the resource already on top changes nothing worth a write.
          if (s.recent[0]?.id === id) return s;
          const entry: RecentResource = {
            id,
            ref: { ctx: ref.ctx, group: ref.group, version: ref.version, plural: ref.plural, kind: ref.kind, name: ref.name, namespace: ref.namespace },
            openedAt: Date.now(),
          };
          return { recent: [entry, ...s.recent.filter((r) => r.id !== id)].slice(0, RECENT_LIMIT) };
        }),
      remove: (id) => set((s) => ({ recent: s.recent.filter((r) => r.id !== id) })),
      clear: () => set({ recent: [] }),
    }),
    { name: 'kubus-recent', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);

/** Remember a resource as recently opened while `ref` identifies an open detail view. */
export function useRecordRecent(ref: (Omit<ResourceRef, 'kind'> & { kind?: string }) | undefined): void {
  const key = ref?.kind ? resourceResultId(ref) : '';
  useEffect(() => {
    if (!ref?.kind) return;
    useRecentStore.getState().record({ ...ref, kind: ref.kind });
    // Keyed on the resource identity: re-renders of the same selection don't re-record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
