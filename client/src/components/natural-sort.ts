import type { GridColDef, GridComparatorFn, GridValidRowModel } from '@mui/x-data-grid';

// One shared collator: constructing one per comparison is the expensive part.
const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * Human ordering for names: digit runs compare by value, so `worker-2` sorts
 * before `worker-10`. Empty values sort first, like the grid's default.
 */
export function naturalCompare(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(sortText(a), sortText(b));
}

function sortText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

export const naturalSortComparator: GridComparatorFn = (a, b) => naturalCompare(a, b);

/**
 * Give a text column natural ordering. Numeric, date and boolean columns and
 * columns that bring their own comparator are returned unchanged.
 */
export function withNaturalSort<R extends GridValidRowModel>(column: GridColDef<R>): GridColDef<R> {
  if (column.sortComparator || (column.type && column.type !== 'string')) return column;
  return { ...column, sortComparator: naturalSortComparator };
}
