import type { ClusterRow } from '../api/queries.js';

/** Cell padding (10px a side) plus a little air. */
const CELL_CHROME = 26;
const MIN_WIDTH = 180;
/** Only the longest names can set the width; measuring these few is enough. */
const MEASURED = 12;
const STEP = 8;

let context: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (context === undefined) {
    // jsdom has no canvas and logs a "not implemented" error when asked.
    const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
    context = jsdom || typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!context) return text.length * 7.2;
  context.font = font;
  return context.measureText(text).width;
}

/** The `count` longest names, by character length. */
function longestNames(rows: readonly ClusterRow[], count: number): string[] {
  const top: string[] = [];
  for (const row of rows) {
    const name = row.obj.metadata.name;
    if (top.length === count && name.length <= top[count - 1]!.length) continue;
    let i = top.length;
    while (i > 0 && top[i - 1]!.length < name.length) i--;
    top.splice(i, 0, name);
    if (top.length > count) top.pop();
  }
  return top;
}

/**
 * Width that shows the longest name in full, capped at `maxShare` of the
 * table so a single long CRD name can't push every other column away.
 * Rounded up to 8px so small changes in the row set don't resize the column.
 */
export function nameColumnWidth(rows: readonly ClusterRow[], font: string, tableWidth: number, maxShare = 0.45): number {
  let widest = 0;
  for (const name of longestNames(rows, MEASURED)) widest = Math.max(widest, textWidth(name, font));
  const wanted = Math.ceil((widest + CELL_CHROME) / STEP) * STEP;
  return Math.min(nameColumnCap(tableWidth, maxShare), Math.max(MIN_WIDTH, wanted));
}

/** The most a table of this width gives its Name column (no cap before it is measured). */
export function nameColumnCap(tableWidth: number, maxShare = 0.45): number {
  if (tableWidth <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(MIN_WIDTH, Math.floor((tableWidth * maxShare) / STEP) * STEP);
}
