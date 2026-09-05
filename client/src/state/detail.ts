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
  /** The Data editor holds staged edits; they live in the editor, so leaving it is guarded. */
  dataDirty: boolean;
  /**
   * Unapplied manifest/YAML edits per resource (keyed by selection). They
   * outlive the drawer: closing it, navigating away or opening a dock action
   * keeps them, and they are back the next time the resource is opened.
   */
  drafts: Record<string, ManifestDraft>;
  /** Action stalled behind the discard confirmation while the Data editor is dirty. */
  pendingDiscard?: () => void;
  open: (sel: ResourceSelection, opts?: { embedded?: boolean }) => void;
  push: (sel: ResourceSelection, opts?: { embedded?: boolean }) => void;
  back: () => void;
  close: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setWidth: (width: number) => void;
  requestFocus: () => void;
  setDataDirty: (dirty: boolean) => void;
  /** Stage manifest/YAML edits for their resource; a draft equal to its base is dropped. */
  setDraft: (draft: ManifestDraft) => void;
  clearDraft: (selKey: string) => void;
  /** Run now, or stall behind the discard confirmation while the Data editor is dirty. */
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

export const useDetailStore = create<DetailState>((set, get) => {
  const update = (patch: Partial<DetailState>) => set(patch);
  return {
    stack: [],
    embedded: false,
    collapsed: false,
    width: DEFAULT_DETAIL_WIDTH,
    focusSeq: 0,
    dataDirty: false,
    drafts: {},
    // Selection changes come from anywhere (row clicks, topology, events,
    // search) and replace the mounted detail — guard them so staged Data-tab
    // edits aren't dropped without confirmation. Re-opening the same resource
    // doesn't remount the editor, so it passes through.
    open: (sel, opts) => {
      const embedded = opts?.embedded ?? false;
      const { stack } = get();
      const sameSel = stack.length === 1 && selKeyOf(stack[0]!) === selKeyOf(sel);
      if (sameSel && embedded === get().embedded && stack[0]!.kind === sel.kind && stack[0]!.custom === sel.custom) return;
      if (sameSel) update({ stack: [sel], embedded });
      else get().guard(() => update({ stack: [sel], embedded }));
    },
    // Pushes can come from outside the panel (e.g. the API-resource drawer's
    // CRD link), so surface the result even if the panel was collapsed. A push
    // extends whichever surface owns the stack, so the embedded flag is kept
    // unless the caller states ownership — needed when a push seeds an empty
    // stack (list pages can open their CRD with no row selected).
    push: (sel, opts) => get().guard(() => set((s) => ({ stack: [...s.stack, sel], collapsed: false, embedded: opts?.embedded ?? s.embedded }))),
    back: () => update({ stack: get().stack.slice(0, -1) }),
    // Bail when already closed — close() is called liberally (e.g. on page
    // unmounts), and a fresh [] would re-render every stack subscriber.
    // Drafts stay: nothing typed into the tree or the editor is lost by closing.
    close: () => {
      if (get().stack.length) update({ stack: [] });
    },
    setCollapsed: (collapsed) => set({ collapsed }),
    setWidth: (width) => set({ width: clampDetailWidth(width) }),
    requestFocus: () => set((s) => ({ focusSeq: s.focusSeq + 1, collapsed: false })),
    setDataDirty: (dataDirty) => {
      if (get().dataDirty !== dataDirty) update({ dataDirty });
    },
    setDraft: (draft) => {
      const drafts = { ...get().drafts };
      if (draftDirty(draft)) drafts[draft.selKey] = draft;
      else delete drafts[draft.selKey];
      update({ drafts });
    },
    clearDraft: (selKey) => {
      if (!get().drafts[selKey]) return;
      const drafts = { ...get().drafts };
      delete drafts[selKey];
      update({ drafts });
    },
    guard: (action) => {
      if (get().dataDirty) set({ pendingDiscard: action });
      else action();
    },
    confirmDiscard: () => {
      const action = get().pendingDiscard;
      update({ dataDirty: false, pendingDiscard: undefined });
      action?.();
    },
    cancelDiscard: () => set({ pendingDiscard: undefined }),
  };
});
