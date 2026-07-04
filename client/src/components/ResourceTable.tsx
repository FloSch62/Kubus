import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Box, Chip, IconButton, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import { DataGrid, type GridColDef, type GridColumnVisibilityModel, type GridRowParams } from '@mui/x-data-grid';
import type { ClusterRow } from '../api/queries.js';
import { useUiPrefsStore } from '../state/prefs.js';

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    target.isContentEditable ||
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    !!target.closest('[contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], .monaco-editor')
  );
}

interface Props {
  rows: ClusterRow[];
  columns: GridColDef<ClusterRow>[];
  loading?: boolean;
  statusText?: string;
  filter?: string;
  labelSelector?: string;
  fieldSelector?: string;
  onFilterChange?: (value: string) => void;
  onLabelSelectorChange?: (value: string) => void;
  onFieldSelectorChange?: (value: string) => void;
  onRowClick?: (row: ClusterRow) => void;
  onRowContextMenu?: (row: ClusterRow, event: MouseEvent<HTMLElement>) => void;
  /** Extra toolbar elements (e.g. create button). */
  toolbar?: ReactNode;
  /** Enable checkbox selection; returns selected rows. */
  onSelectionChange?: (rows: ClusterRow[]) => void;
  checkboxSelection?: boolean;
  /** Column fields hidden by default (user can re-enable via the column menu). */
  hiddenFields?: string[];
  /** Stable id used to persist user-resized column widths for this table. */
  tableId?: string;
}

export function ResourceTable({
  rows,
  columns,
  loading,
  statusText,
  filter,
  labelSelector,
  fieldSelector,
  onFilterChange,
  onLabelSelectorChange,
  onFieldSelectorChange,
  onRowClick,
  onRowContextMenu,
  toolbar,
  checkboxSelection,
  onSelectionChange,
  hiddenFields,
  tableId,
}: Props) {
  const [localFilter, setLocalFilter] = useState('');
  const activeFilter = filter ?? localFilter;
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hiddenKey = (hiddenFields ?? []).join(',');
  const [visibility, setVisibility] = useState<GridColumnVisibilityModel>({});
  const tableDensity = useUiPrefsStore((s) => s.tableDensity);
  // Retrieve this table's saved column widths (if any)
  const storedWidths = useUiPrefsStore((s) => (tableId ? s.columnWidths[tableId] : undefined));
  // Retrieve the action used to persist a column width
  const setColumnWidth = useUiPrefsStore((s) => s.setColumnWidth);
  useEffect(() => {
    setVisibility(Object.fromEntries(hiddenKey ? hiddenKey.split(',').map((f) => [f, false]) : []));
  }, [hiddenKey]);

  // Check the watchlist and rebuild the columns upon detected changes
  const gridColumns = useMemo(() => {
    const result: GridColDef<ClusterRow>[] = [];
    for (const column of columns) {
      let next = column;
      let stored;
      if (storedWidths) {
        stored = storedWidths[column.field];
      }
      // If a saved width exists, make a copy of the column with that width applied
      if (stored !== undefined) {
        next = { ...next, width: stored, flex: undefined };
      }
      // If this column draws custom cells, make sure they lay out correctly
      if (next.renderCell && !next.display) {
        next = { ...next, display: 'flex' as const };
      }
      result.push(next);
    }

    // Hand back the whole adjusted list.
    return result;
  }, [columns, storedWidths]); // watch list

  const filtered = useMemo(() => {
    if (!activeFilter) return rows;
    const f = activeFilter.toLowerCase();
    return rows.filter(
      (r) =>
        r.obj.metadata.name.toLowerCase().includes(f) ||
        (r.obj.metadata.namespace ?? '').toLowerCase().includes(f) ||
        r.ctx.toLowerCase().includes(f),
    );
  }, [rows, activeFilter]);

  const rowsById = useMemo(() => new Map(filtered.map((row) => [row.obj.metadata.uid, row])), [filtered]);

  const setTextFilter = (value: string) => {
    if (onFilterChange) onFilterChange(value);
    else setLocalFilter(value);
  };

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextEntryTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const shortcutModifier = event.ctrlKey || event.metaKey;
      const isFindShortcut = shortcutModifier && !event.altKey && !event.shiftKey && key === 'f';
      const isQuickSearchShortcut = !shortcutModifier && !event.altKey && (key === 's' || key === ':');
      if (!isFindShortcut && !isQuickSearchShortcut) return;
      event.preventDefault();
      event.stopPropagation();
      focusSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusSearch]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, flexShrink: 0, alignItems: 'center' }}>
        <TextField
          inputRef={searchInputRef}
          placeholder="Search…"
          value={activeFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          sx={{ width: 240 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
              endAdornment: activeFilter ? (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="Clear table search"
                    edge="end"
                    size="small"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setTextFilter('')}
                    sx={{ mr: -0.75 }}
                  >
                    <ClearIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
        {onLabelSelectorChange && (
          <TextField
            placeholder="Label selector"
            value={labelSelector ?? ''}
            onChange={(e) => onLabelSelectorChange(e.target.value)}
            sx={{ width: 220 }}
          />
        )}
        {onFieldSelectorChange && (
          <TextField
            placeholder="Field selector"
            value={fieldSelector ?? ''}
            onChange={(e) => onFieldSelectorChange(e.target.value)}
            sx={{ width: 220 }}
          />
        )}
        <Chip label={`${filtered.length} items`} variant="outlined" />
        {statusText && (
          <Typography variant="caption" color="warning.main">
            {statusText}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {toolbar}
      </Stack>
      <DataGrid
        rows={filtered}
        columns={gridColumns}
        loading={loading}
        getRowId={(r) => r.obj.metadata.uid}
        density={tableDensity === 'comfortable' ? 'standard' : 'compact'}
        checkboxSelection={checkboxSelection}
        onRowSelectionModelChange={
          onSelectionChange
            ? (model) => {
                const ids = model.ids instanceof Set ? model.ids : new Set();
                onSelectionChange(filtered.filter((r) => ids.has(r.obj.metadata.uid)));
              }
            : undefined
        }
        disableRowSelectionOnClick={!!checkboxSelection}
        onRowClick={onRowClick ? (params: GridRowParams<ClusterRow>) => onRowClick(params.row) : undefined}
        slotProps={
          onRowContextMenu
            ? {
                row: {
                  onContextMenu: (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const id = event.currentTarget.getAttribute('data-id');
                    const row = id ? rowsById.get(id) : undefined;
                    if (row) onRowContextMenu(row, event);
                  },
                },
              }
            : undefined
        }
        columnVisibilityModel={visibility}
        onColumnVisibilityModelChange={setVisibility}
        onColumnWidthChange={tableId ? (params) => setColumnWidth(tableId, params.colDef.field, params.width) : undefined}
        initialState={{ sorting: { sortModel: [{ field: 'name', sort: 'asc' }] } }}
        sx={{
          border: 0,
          flex: 1,
          minHeight: 0,
          '& .MuiDataGrid-row': { cursor: onRowClick ? 'pointer' : 'default' },
          '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
        }}
      />
    </Box>
  );
}
