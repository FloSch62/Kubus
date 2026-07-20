import { create } from 'zustand';
import type { ResourceSelection } from '../components/ResourceDetailDrawer.js';

/**
 * Global resource-detail drawer state. The stack enables related-resource
 * navigation (e.g. Pod → Node → a pod on that node) with a back button;
 * `open` is the entry point from list pages and replaces the stack.
 */
interface DetailState {
  stack: ResourceSelection[];
  /** Embedded panel shrunk to its handle; the selection stays live. */
  collapsed: boolean;
  /** Embedded panel width in px; user-resizable via the divider. */
  width: number;
  /** Bumped when keyboard flows want focus moved into the panel. */
  focusSeq: number;
  /** The Data editor holds staged, unapplied key edits. */
  dataDirty: boolean;
  /** Action stalled behind the discard confirmation while dataDirty. */
  pendingDiscard?: () => void;
  open: (sel: ResourceSelection) => void;
  push: (sel: ResourceSelection) => void;
  back: () => void;
  close: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setWidth: (width: number) => void;
  requestFocus: () => void;
  setDataDirty: (dirty: boolean) => void;
  /** Run now, or stall behind the discard confirmation while the Data editor is dirty. */
  guard: (action: () => void) => void;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
}

export const DEFAULT_DETAIL_WIDTH = 640;

export function clampDetailWidth(width: number): number {
  return Math.max(380, Math.min(Math.round(window.innerWidth * 0.7), width));
}

function selKeyOf(sel: ResourceSelection): string {
  return `${sel.ctx}|${sel.group}|${sel.version}|${sel.plural}|${sel.namespace ?? ''}|${sel.name}`;
}

export const useDetailStore = create<DetailState>((set, get) => ({
  stack: [],
  collapsed: false,
  width: DEFAULT_DETAIL_WIDTH,
  focusSeq: 0,
  dataDirty: false,
  // Selection changes come from anywhere (row clicks, topology, events,
  // search) and replace the mounted detail — guard them so staged Data-tab
  // edits aren't dropped without confirmation. Re-opening the same resource
  // doesn't remount the editor, so it passes through.
  open: (sel) => {
    const { stack } = get();
    const sameSel = stack.length === 1 && selKeyOf(stack[0]!) === selKeyOf(sel);
    if (sameSel) set({ stack: [sel] });
    else get().guard(() => set({ stack: [sel] }));
  },
  // Pushes can come from outside the panel (e.g. the API-resource drawer's
  // CRD link), so surface the result even if the panel was collapsed.
  push: (sel) => get().guard(() => set((s) => ({ stack: [...s.stack, sel], collapsed: false }))),
  back: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  // Bail when already closed — close() is called liberally (e.g. on page
  // unmounts), and a fresh [] would re-render every stack subscriber.
  close: () => set((s) => (s.stack.length ? { stack: [] } : s)),
  setCollapsed: (collapsed) => set({ collapsed }),
  setWidth: (width) => set({ width: clampDetailWidth(width) }),
  requestFocus: () => set((s) => ({ focusSeq: s.focusSeq + 1, collapsed: false })),
  setDataDirty: (dirty) => set((s) => (s.dataDirty === dirty ? s : { dataDirty: dirty })),
  guard: (action) => {
    if (get().dataDirty) set({ pendingDiscard: action });
    else action();
  },
  confirmDiscard: () => {
    const action = get().pendingDiscard;
    set({ dataDirty: false, pendingDiscard: undefined });
    action?.();
  },
  cancelDiscard: () => set({ pendingDiscard: undefined }),
}));
