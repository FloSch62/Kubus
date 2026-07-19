import { create } from 'zustand';

/** Transient nav-overlay state (narrow viewports); deliberately not persisted. */
export const useNavUiStore = create<{ overlayOpen: boolean; setOverlayOpen: (open: boolean) => void }>()((set) => ({
  overlayOpen: false,
  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
}));

/** Below this width the pinned nav rail becomes an on-demand overlay. */
export const NAV_OVERLAY_MEDIA_QUERY = '(max-width: 900px)';
