import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { FavoriteItem, SavedView } from '@kubus/shared';
import { kubusStateStorage } from './persist-storage.js';

interface NavigationState {
  favorites: FavoriteItem[];
  savedViews: SavedView[];
  addFavorite: (item: FavoriteItem) => void;
  removeFavorite: (id: string) => void;
  moveFavorite: (id: string, targetId: string, position: 'before' | 'after') => void;
  isFavorite: (id: string) => boolean;
  addSavedView: (view: SavedView) => void;
  removeSavedView: (id: string) => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      favorites: [],
      savedViews: [],
      addFavorite: (item) =>
        set((s) => ({
          favorites: [item, ...s.favorites.filter((f) => f.id !== item.id)].slice(0, 40),
        })),
      removeFavorite: (id) => set((s) => ({ favorites: s.favorites.filter((f) => f.id !== id) })),
      moveFavorite: (id, targetId, position) =>
        set((s) => {
          if (id === targetId) return s;
          const moving = s.favorites.find((f) => f.id === id);
          if (!moving) return s;
          const withoutMoving = s.favorites.filter((f) => f.id !== id);
          const targetIndex = withoutMoving.findIndex((f) => f.id === targetId);
          if (targetIndex === -1) return s;
          const next = [...withoutMoving];
          next.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, moving);
          return { favorites: next };
        }),
      isFavorite: (id) => get().favorites.some((f) => f.id === id),
      addSavedView: (view) =>
        set((s) => ({
          savedViews: [view, ...s.savedViews.filter((v) => v.id !== view.id)].slice(0, 30),
        })),
      removeSavedView: (id) => set((s) => ({ savedViews: s.savedViews.filter((v) => v.id !== id) })),
    }),
    { name: 'kubus-navigation', version: 0, storage: createJSONStorage(() => kubusStateStorage) },
  ),
);
