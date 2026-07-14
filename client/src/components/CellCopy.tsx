import { memo, useEffect, useRef, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { GridColDef, GridEventListener, GridValidRowModel } from '@mui/x-data-grid';
import { copyToClipboard } from '../clipboard.js';

/** The text a cell copies: the raw (unformatted) value the grid computed. */
export function cellCopyText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)?.trim() ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

const CellCopyButton = memo(function CellCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetRef.current), []);
  return (
    <IconButton
      className="kubus-cell-copy"
      size="small"
      tabIndex={-1}
      aria-label="Copy value"
      title="Copy"
      onClick={(event) => {
        event.stopPropagation();
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(resetRef.current);
          resetRef.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        // Keep focus where it was: no cell focus-within outline after copying.
        event.preventDefault();
      }}
      sx={{
        position: 'absolute',
        top: '50%',
        right: 2,
        transform: 'translateY(-50%)',
        p: 0.25,
        borderRadius: 1,
        opacity: 0,
        pointerEvents: 'none',
        transition: 'opacity 120ms',
        bgcolor: 'background.paper',
        boxShadow: 1,
        '&:hover': { bgcolor: 'background.paper' },
      }}
    >
      {copied ? <CheckIcon sx={{ fontSize: 14 }} color="success" /> : <ContentCopyIcon sx={{ fontSize: 14 }} />}
    </IconButton>
  );
});

/**
 * Wrap a column so every non-empty cell gets a hover copy button overlaid at
 * its right edge. Columns without a custom renderCell keep their default
 * text rendering (ellipsis + alignment handled by `.kubus-cell-text`, see
 * copyCellGridSx). Requires copyCellGridSx on the grid's `sx`.
 */
export function withCellCopy<R extends GridValidRowModel>(column: GridColDef<R>): GridColDef<R> {
  const original = column.renderCell;
  const align = column.align ?? (column.type === 'number' ? 'right' : 'left');
  return {
    ...column,
    display: column.display ?? 'flex',
    renderCell: (params) => {
      const text = cellCopyText(params.value);
      return (
        <>
          {original ? (
            original(params)
          ) : (
            <span className="kubus-cell-text" style={{ textAlign: align }}>
              {String(params.formattedValue ?? params.value ?? '')}
            </span>
          )}
          {text ? <CellCopyButton text={text} /> : null}
        </>
      );
    },
  };
}

/** Ctrl/Cmd+C on a focused cell copies its value and flashes the cell. */
export const handleCopyCellKeyDown: GridEventListener<'cellKeyDown'> = (params, event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (event.key.toLowerCase() !== 'c') return;
  // A real text selection means the user wants the native copy behavior.
  if (window.getSelection()?.toString()) return;
  const text = cellCopyText(params.value);
  if (!text) return;
  const cell = (event.target as HTMLElement | null)?.closest?.('.MuiDataGrid-cell');
  void copyToClipboard(text).then((ok) => {
    if (!ok || !cell) return;
    cell.classList.remove('kubus-cell-copied-flash');
    // Force a reflow so copying the same cell twice restarts the animation.
    void (cell as HTMLElement).offsetWidth;
    cell.classList.add('kubus-cell-copied-flash');
  });
};

/** Grid `sx` styles required by withCellCopy / handleCopyCellKeyDown. */
export const copyCellGridSx = {
  '& .MuiDataGrid-cell': { position: 'relative' },
  '& .MuiDataGrid-cell:hover .kubus-cell-copy': { opacity: 1, pointerEvents: 'auto' },
  '& .kubus-cell-text': {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '& .kubus-cell-copied-flash': { animation: 'kubus-cell-copied-flash 600ms ease-out' },
  '@keyframes kubus-cell-copied-flash': {
    from: { backgroundColor: 'rgba(46, 160, 67, 0.35)' },
    to: { backgroundColor: 'transparent' },
  },
};
