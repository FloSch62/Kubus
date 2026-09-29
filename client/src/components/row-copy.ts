import type { GridColDef, GridValidRowModel } from '@mui/x-data-grid';
import { cellCopyText } from './CellCopy.js';

export type RowCopyFormat = 'tsv' | 'csv';

/**
 * Columns a row copy includes: the ones on screen, in order. Unnamed columns
 * (the warning marker) and internal ones (checkbox, row actions) carry no
 * data worth pasting. `hiddenFields` are the table's default-hidden columns;
 * the saved visibility model overrides them per field, as in the grid.
 */
export function copyColumns<R extends GridValidRowModel>(
  columns: GridColDef<R>[],
  hiddenFields: string[] = [],
  visibility: Record<string, boolean> = {},
): GridColDef<R>[] {
  return columns.filter((c) => {
    if (!c.headerName || c.field.startsWith('_')) return false;
    return visibility[c.field] ?? !hiddenFields.includes(c.field);
  });
}

// Column value getters here only read the row; they never touch the grid API.
const NO_GRID_API = { current: null };

function cellValue<R extends GridValidRowModel>(row: R, column: GridColDef<R>): string {
  const raw: unknown = column.valueGetter
    ? column.valueGetter(undefined as never, row, column, NO_GRID_API as never)
    : (row as Record<string, unknown>)[column.field];
  return cellCopyText(raw);
}

function field(value: string, delimiter: string): string {
  // RFC 4180 quoting; spreadsheets read the same quoting from pasted TSV.
  return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A header line plus one line per row, with the raw (unformatted) cell values. */
export function serializeRows<R extends GridValidRowModel>(rows: R[], columns: GridColDef<R>[], format: RowCopyFormat): string {
  const delimiter = format === 'csv' ? ',' : '\t';
  const line = (values: string[]) => values.map((v) => field(v, delimiter)).join(delimiter);
  const lines = [line(columns.map((c) => c.headerName ?? c.field)), ...rows.map((row) => line(columns.map((c) => cellValue(row, c))))];
  return `${lines.join('\n')}\n`;
}
