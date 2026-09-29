import { useState } from 'react';
import Button from '@mui/material/Button';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { GridColDef } from '@mui/x-data-grid';
import type { ClusterRow } from '../api/queries.js';
import { copyToClipboard } from '../clipboard.js';
import { showToast } from '../state/toast.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { copyColumns, serializeRows, type RowCopyFormat } from './row-copy.js';

const NO_VISIBILITY: Record<string, boolean> = {};

/**
 * "Copy rows" for the multi-select bar: the checked rows with the columns on
 * screen, as TSV (pastes straight into a spreadsheet) or CSV.
 */
export function CopyRowsButton({
  rows,
  columns,
  tableId,
  hiddenFields,
}: {
  rows: ClusterRow[];
  columns: GridColDef<ClusterRow>[];
  tableId: string;
  hiddenFields?: string[];
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const visibility = useUiPrefsStore((s) => s.columnVisibility[tableId] ?? NO_VISIBILITY);

  const copy = async (format: RowCopyFormat) => {
    setAnchor(null);
    const cols = copyColumns(columns, hiddenFields, visibility);
    const ok = await copyToClipboard(serializeRows(rows, cols, format));
    showToast(
      ok ? 'success' : 'error',
      ok ? `Copied ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} × ${cols.length} columns as ${format.toUpperCase()}` : 'Copy to clipboard failed',
    );
  };

  return (
    <>
      <Button
        variant="outlined"
        startIcon={<ContentCopyIcon />}
        endIcon={<ArrowDropDownIcon />}
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : undefined}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        Copy rows ({rows.length})
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => void copy('tsv')}>
          <ListItemText primary="As TSV" secondary="Tab-separated, pastes into a spreadsheet" />
        </MenuItem>
        <MenuItem onClick={() => void copy('csv')}>
          <ListItemText primary="As CSV" secondary="Comma-separated, with a header row" />
        </MenuItem>
      </Menu>
    </>
  );
}
