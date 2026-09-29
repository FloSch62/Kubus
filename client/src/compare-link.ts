import { appNavigate } from './app-navigate.js';
import { diffPath, type DiffSide } from './diff-state.js';
import { useTabsStore } from './state/tabs.js';

/** The object behind a row or drawer, as a diff side. */
export function diffSideFor(ref: { ctx: string; group: string; version: string; plural: string; namespace?: string; name: string }): DiffSide {
  return { ctx: ref.ctx, group: ref.group, version: ref.version, plural: ref.plural, namespace: ref.namespace || undefined, name: ref.name };
}

/**
 * Open a compare in a new tab next to the current one, so the list or
 * drawer it started from stays put. Without a right side the Diff page
 * proposes the same object in another cluster and opens the picker.
 */
export function openCompare(left: DiffSide, right?: DiffSide): void {
  const path = diffPath({ left, right });
  useTabsStore.getState().openTab(path, { afterActive: true });
  appNavigate(path);
}
