import type { GridColDef, GridRowId, GridValidRowModel } from '@mui/x-data-grid';
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

/**
 * Put rows in the grid's on-screen order (`sortedIds`, from the grid API).
 * Rows the grid does not show right now keep their relative order at the end.
 */
export function orderRows<R>(rows: R[], rowId: (row: R) => GridRowId, sortedIds: readonly GridRowId[] | undefined): R[] {
  if (!sortedIds?.length || rows.length < 2) return rows;
  const position = new Map(sortedIds.map((id, i) => [id, i]));
  const rank = (row: R) => position.get(rowId(row)) ?? Number.MAX_SAFE_INTEGER;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i)
    .map(({ row }) => row);
}

// Column value getters here only read the row; they never touch the grid API.
const NO_GRID_API = { current: null };

function cellValue<R extends GridValidRowModel>(row: R, column: GridColDef<R>): string {
  const raw: unknown = column.valueGetter
    ? column.valueGetter(undefined as never, row, column, NO_GRID_API as never)
    : (row as Record<string, unknown>)[column.field];
  return cellCopyText(raw);
}

// Spreadsheets run a cell that starts with one of these as a formula, and
// labels, annotations and custom printer columns hold whatever the cluster's
// users wrote. Such cells get a leading apostrophe so they paste as text;
// plain numbers ("-1", "+0.5") stay numbers.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

function field(raw: string, delimiter: string): string {
  const value = neutralizeFormula(raw);
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
