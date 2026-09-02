import { create } from 'zustand';
import type { KubeObject } from '@kubus/shared';
import type { ResourceSelection } from '../components/ResourceDetailDrawer.js';
import { deepEqual } from '../components/detail/manifest-tree.js';

/** Which editor holds unapplied edits (drives the discard dialog's wording). */
export type DirtySource = 'data' | 'manifest' | 'yaml';

/**
 * Unapplied edits to the open resource, shared by the Manifest tree and the
 * YAML editor so switching between them carries the work along. `base` is
 * the snapshot (managed fields stripped) the edits started from; `obj` is
 * authoritative in tree mode and `text` in yaml mode.
 */
export interface ManifestDraft {
  selKey: string;
  base: KubeObject;
  baseText: string;
  obj: KubeObject;
  text: string;
  mode: 'tree' | 'yaml';
}

/**
 * Global resource-detail drawer state. The stack enables related-resource
 * navigation (e.g. Pod → Node → a pod on that node) with a back button;
 * `open` is the entry point from list pages and replaces the stack.
 */
interface DetailState {
  stack: ResourceSelection[];
  /**
   * The stack belongs to a resource list page's embedded side panel (set by
   * its opener). The overlay drawer must ignore embedded-owned selections:
   * when navigating from a list page to another page, the page unmount clears
   * the selection one commit after the route changes — without this flag the
   * overlay would mount open for that one commit and immediately close, and
   * that interrupted enter→exit transition can strand MUI's Modal portal as
   * an invisible, input-eating overlay (seen in the wild as a frozen app).
   */
  embedded: boolean;
  /** Embedded panel shrunk to its handle; the selection stays live. */
  collapsed: boolean;
  /** Embedded panel width in px; user-resizable via the divider. */
  width: number;
  /** Bumped when keyboard flows want focus moved into the panel. */
  focusSeq: number;
  /** An editor holds staged, unapplied edits. */
  dirty: DirtySource | false;
  /** Manifest/YAML edits for the open resource; dropped when they equal the base again. */
  draft?: ManifestDraft;
  /** Action stalled behind the discard confirmation while dirty. */
  pendingDiscard?: () => void;
  open: (sel: ResourceSelection, opts?: { embedded?: boolean }) => void;
  push: (sel: ResourceSelection, opts?: { embedded?: boolean }) => void;
  back: () => void;
  close: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setWidth: (width: number) => void;
  requestFocus: () => void;
  /** The Data editor's staged-edits flag; the manifest draft keeps its own dirtiness. */
  setDataDirty: (dirty: boolean) => void;
  /** Stage manifest/YAML edits; a draft equal to its base is dropped. */
  setDraft: (draft: ManifestDraft | undefined) => void;
  /** Run now, or stall behind the discard confirmation while an editor is dirty. */
  guard: (action: () => void) => void;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
}

export const DEFAULT_DETAIL_WIDTH = 640;

export function clampDetailWidth(width: number): number {
  return Math.max(380, Math.min(Math.round(window.innerWidth * 0.7), width));
}

export function selKeyOf(sel: ResourceSelection): string {
  return `${sel.ctx}|${sel.group}|${sel.version}|${sel.plural}|${sel.namespace ?? ''}|${sel.name}`;
}

/** Whether a draft still differs from the snapshot it started from. */
export function draftDirty(draft: ManifestDraft): DirtySource | false {
  if (draft.mode === 'yaml') return draft.text !== draft.baseText ? 'yaml' : false;
  return deepEqual(draft.obj, draft.base) ? false : 'manifest';
}

export const useDetailStore = create<DetailState>((set, get) => ({
  stack: [],
  embedded: false,
  collapsed: false,
  width: DEFAULT_DETAIL_WIDTH,
  focusSeq: 0,
  dirty: false,
  // Selection changes come from anywhere (row clicks, topology, events,
  // search) and replace the mounted detail — guard them so staged Data-tab
  // edits aren't dropped without confirmation. Re-opening the same resource
  // doesn't remount the editor, so it passes through.
  open: (sel, opts) => {
    const embedded = opts?.embedded ?? false;
    const { stack } = get();
    const sameSel = stack.length === 1 && selKeyOf(stack[0]!) === selKeyOf(sel);
    if (sameSel) set({ stack: [sel], embedded });
    else get().guard(() => set({ stack: [sel], embedded, draft: undefined }));
  },
  // Pushes can come from outside the panel (e.g. the API-resource drawer's
  // CRD link), so surface the result even if the panel was collapsed. A push
  // extends whichever surface owns the stack, so the embedded flag is kept
  // unless the caller states ownership — needed when a push seeds an empty
  // stack (list pages can open their CRD with no row selected).
  push: (sel, opts) =>
    get().guard(() => set((s) => ({ stack: [...s.stack, sel], collapsed: false, embedded: opts?.embedded ?? s.embedded, draft: undefined }))),
  back: () => set((s) => ({ stack: s.stack.slice(0, -1), draft: undefined })),
  // Bail when already closed — close() is called liberally (e.g. on page
  // unmounts), and a fresh [] would re-render every stack subscriber.
  close: () => set((s) => (s.stack.length ? { stack: [], draft: undefined, dirty: false } : s)),
  setCollapsed: (collapsed) => set({ collapsed }),
  setWidth: (width) => set({ width: clampDetailWidth(width) }),
  requestFocus: () => set((s) => ({ focusSeq: s.focusSeq + 1, collapsed: false })),
  setDataDirty: (dataDirty) =>
    set((s) => {
      const dirty: DirtySource | false = dataDirty ? 'data' : s.draft ? draftDirty(s.draft) : false;
      return s.dirty === dirty ? s : { dirty };
    }),
  setDraft: (draft) => {
    const dirty = draft ? draftDirty(draft) : false;
    set({ draft: dirty ? draft : undefined, dirty });
  },
  guard: (action) => {
    if (get().dirty) set({ pendingDiscard: action });
    else action();
  },
  // Discarding answers the guard that was raised: for the Data tab's edits a
  // manifest draft the dialog never mentioned survives, for a manifest/YAML
  // draft the draft itself is dropped.
  confirmDiscard: () => {
    const action = get().pendingDiscard;
    set((s) =>
      s.dirty === 'data'
        ? { dirty: s.draft ? draftDirty(s.draft) : false, pendingDiscard: undefined }
        : { dirty: false, draft: undefined, pendingDiscard: undefined },
    );
    action?.();
  },
  cancelDiscard: () => set({ pendingDiscard: undefined }),
}));
