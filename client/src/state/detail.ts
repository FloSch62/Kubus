import { create } from 'zustand';
import type { ResourceSelection } from '../components/ResourceDetailDrawer.js';

/**
 * Global resource-detail drawer state. The stack enables related-resource
 * navigation (e.g. Pod → Node → a pod on that node) with a back button;
 * `open` is the entry point from list pages and replaces the stack.
 */
interface DetailState {
  stack: ResourceSelection[];
  open: (sel: ResourceSelection) => void;
  push: (sel: ResourceSelection) => void;
  back: () => void;
  close: () => void;
}

export const useDetailStore = create<DetailState>((set) => ({
  stack: [],
  open: (sel) => set({ stack: [sel] }),
  push: (sel) => set((s) => ({ stack: [...s.stack, sel] })),
  back: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  // Bail when already closed — close() is called liberally (e.g. on page
  // unmounts), and a fresh [] would re-render every stack subscriber.
  close: () => set((s) => (s.stack.length ? { stack: [] } : s)),
}));
