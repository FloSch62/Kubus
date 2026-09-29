import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  gridExpandedSortedRowIdsSelector,
  gridPaginatedVisibleSortedGridRowIdsSelector,
  type GridCallbackDetails,
  type GridCellParams,
} from '@mui/x-data-grid';
import { rowCursorStep, rowKeyForEvent, type RowKeyAction } from '../row-keys.js';
import { isTextEntryTarget } from '../text-entry.js';

/** The grid API ref every DataGrid callback receives in its details. */
type GridApiRef = GridCallbackDetails['apiRef'];

/**
 * Single-key handling for a focused grid cell: `j`/`k` move the cell focus a
 * row down/up in the same column (the row cursor, next to the arrow keys),
 * and the row action keys go to `onRowKey`, which answers whether the row
 * has that action. Returns true when the key was used.
 *
 * Only cell key presses reach here, so the keys never fire from the filter
 * box; typing surfaces inside the grid's React tree (a dialog or menu opened
 * from a row, which bubbles through its portal) are skipped explicitly.
 */
export function handleGridRowKey<Row>(
  apiRef: GridApiRef,
  params: GridCellParams,
  event: ReactKeyboardEvent,
  row: Row,
  onRowKey: ((row: Row, action: RowKeyAction) => boolean) | undefined,
): boolean {
  if (event.defaultPrevented || isTextEntryTarget(event.target)) return false;
  const step = rowCursorStep(event);
  if (step) {
    event.preventDefault();
    // After the grid's own cellKeyDown handlers: its focus hook puts focus
    // back on the pressed cell for every non-navigation key.
    queueMicrotask(() => moveRowCursor(apiRef, params, step));
    return true;
  }
  const action = onRowKey && !event.repeat ? rowKeyForEvent(event) : undefined;
  if (!action || !onRowKey?.(row, action)) return false;
  // Keeps window listeners (the `s` filter shortcut, `c` create) out of it.
  event.preventDefault();
  return true;
}

function moveRowCursor(apiRef: GridApiRef, params: GridCellParams, step: 1 | -1): void {
  const api = apiRef.current;
  if (!api) return;
  // Stay on the current page, like the arrow keys.
  const pageIds = gridPaginatedVisibleSortedGridRowIdsSelector(apiRef);
  const index = pageIds.indexOf(params.id);
  const nextId = index === -1 ? undefined : pageIds[index + step];
  if (nextId === undefined) return;
  const rowIndex = gridExpandedSortedRowIdsSelector(apiRef).indexOf(nextId);
  api.scrollToIndexes({ rowIndex, colIndex: api.getColumnIndex(params.field) });
  api.setCellFocus(nextId, params.field);
}
