import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FavoriteItem, SavedView } from '@kubus/shared';

interface NavigationState {
  favorites: FavoriteItem[];
  savedViews: SavedView[];
  addFavorite: (item: FavoriteItem) => void;
  removeFavorite: (id: string) => void;
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
      isFavorite: (id) => get().favorites.some((f) => f.id === id),
      addSavedView: (view) =>
        set((s) => ({
          savedViews: [view, ...s.savedViews.filter((v) => v.id !== view.id)].slice(0, 30),
        })),
      removeSavedView: (id) => set((s) => ({ savedViews: s.savedViews.filter((v) => v.id !== id) })),
    }),
    { name: 'kubus-navigation' },
  ),
);
