import type { SavedViewGridState } from '@kubus/shared';
import { useClustersStore } from './clusters.js';
import { useUiPrefsStore } from './prefs.js';

/** Apply one saved-view snapshot as a complete grid state, including defaults. */
export function applySavedViewGridState(path: string, grid: SavedViewGridState): void {
  useClustersStore.getState().setNamespaces(grid.namespaces ?? []);
  const tableId = path.split('?')[0] || path;
  useUiPrefsStore.getState().applyTableState(tableId, grid);
}
