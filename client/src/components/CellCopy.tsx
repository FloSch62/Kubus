import { memo, useEffect, useRef, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { GridColDef, GridEventListener, GridValidRowModel } from '@mui/x-data-grid';
import { copyToClipboard } from '../clipboard.js';
import { TruncationTooltip } from './truncation.js';

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

/** Standalone always-visible copy button for detail views (the grid variant below hides until hover). */
export const CopyValueButton = memo(function CopyValueButton({ text, label = 'Copy value' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetRef.current), []);
  return (
    <IconButton
      size="small"
      aria-label={label}
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
      sx={{ p: 0.25 }}
    >
      {copied ? <CheckIcon sx={{ fontSize: 14 }} color="success" /> : <ContentCopyIcon sx={{ fontSize: 14 }} />}
    </IconButton>
  );
});

// One of these renders in every non-empty cell, and scrolling mounts them by
// the hundred — so it is a plain DOM button (styles in copyCellGridSx, copied
// state flipped as a class) instead of a stateful MUI IconButton.
const copyResetTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function stopEventPropagation(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function suppressFocusSteal(event: React.MouseEvent) {
  event.stopPropagation();
  // Keep focus where it was: no cell focus-within outline after copying.
  event.preventDefault();
}

const cellCopyIcons = (
  <>
    <svg className="kubus-cell-copy-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
    <svg className="kubus-cell-copy-check" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  </>
);

const CellCopyButton = memo(function CellCopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="kubus-cell-copy"
      tabIndex={-1}
      aria-label="Copy value"
      title="Copy"
      onClick={(event) => {
        event.stopPropagation();
        const button = event.currentTarget;
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          button.classList.add('kubus-cell-copied');
          clearTimeout(copyResetTimers.get(button));
          copyResetTimers.set(
            button,
            setTimeout(() => button.classList.remove('kubus-cell-copied'), 1200),
          );
        });
      }}
      onDoubleClick={stopEventPropagation}
      onMouseDown={suppressFocusSteal}
    >
      {cellCopyIcons}
    </button>
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
      const display = String(params.formattedValue ?? params.value ?? '');
      return (
        <>
          {original ? (
            original(params)
          ) : (
            <TruncationTooltip text={display}>
              <span className="kubus-cell-text" style={{ textAlign: align }}>
                {display}
              </span>
            </TruncationTooltip>
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
  '& .kubus-cell-copy': {
    position: 'absolute',
    top: '50%',
    right: 2,
    transform: 'translateY(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    p: '3px',
    m: 0,
    border: 0,
    borderRadius: 1,
    cursor: 'pointer',
    opacity: 0,
    pointerEvents: 'none',
    transition: 'opacity 120ms',
    bgcolor: 'background.paper',
    boxShadow: 1,
    color: 'action.active',
    '& svg': { width: 14, height: 14, fill: 'currentColor', display: 'block' },
    '& .kubus-cell-copy-check': { display: 'none', color: 'success.main' },
    '&.kubus-cell-copied .kubus-cell-copy-icon': { display: 'none' },
    '&.kubus-cell-copied .kubus-cell-copy-check': { display: 'block' },
  },
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
