import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DataGrid, type GridColDef, type GridColumnVisibilityModel, type GridRowParams } from '@mui/x-data-grid';
import type { ClusterRow } from '../api/queries.js';
import { matchesPlainText, matchesSmartFilter, parseSmartFilter } from '../smart-filter.js';
import { joinLabelSelector, splitLabelSelector } from '../label-selector.js';
import { SmartFilterInput } from './SmartFilterInput.js';
import type { MetricsLookup } from './columns.js';
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
  /** Resource kind shown — drives smart-filter status/metrics semantics. */
  kind?: string;
  /** Live metrics lookup backing cpu>/mem> filter clauses. */
  metricsLookup?: MetricsLookup;
  filter?: string;
  labelSelector?: string;
  onFilterChange?: (value: string) => void;
  onLabelSelectorChange?: (value: string) => void;
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

const labelFilterOptions = createFilterOptions<string>({ limit: 100 });

/** All `key` and `key=value` selector terms present in the rows. */
function labelSelectorOptions(rows: ClusterRow[]): { terms: string[]; keys: Set<string> } {
  const keys = new Set<string>();
  const values = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.obj.metadata.labels ?? {})) {
      keys.add(key);
      values.add(`${key}=${value}`);
    }
  }
  return { terms: [...keys, ...values].sort((a, b) => a.localeCompare(b)), keys };
}

export function ResourceTable({
  rows,
  columns,
  loading,
  statusText,
  kind,
  metricsLookup,
  filter,
  labelSelector,
  onFilterChange,
  onLabelSelectorChange,
  onRowClick,
  onRowContextMenu,
  toolbar,
  checkboxSelection,
  onSelectionChange,
  hiddenFields,
  tableId,
}: Props) {
  const [localFilter, setLocalFilter] = useState('');
  // The committed value lives in the URL (or localFilter); the input itself is
  // local state so typing never waits on a router round-trip, and the commit
  // is debounced so fast typing doesn't spam history/navigation.
  const committedFilter = filter ?? localFilter;
  const [inputValue, setInputValue] = useState(committedFilter);
  const committedRef = useRef(committedFilter);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // External commits (saved view click, back/forward, clear) reset the input.
  useEffect(() => {
    if (committedFilter !== committedRef.current) {
      committedRef.current = committedFilter;
      setInputValue(committedFilter);
    }
  }, [committedFilter]);
  useEffect(() => () => clearTimeout(commitTimer.current), []);

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

  // Filter on the deferred value so keystrokes render before the table does.
  const deferredFilter = useDeferredValue(inputValue);
  const filtered = useMemo(() => {
    const query = deferredFilter.trim();
    if (!query) return rows;
    const resourceKind = kind ?? 'Resource';
    if (query.startsWith('/')) {
      const clauses = parseSmartFilter(query.slice(1));
      if (!clauses.length) return rows;
      const ctx = { kind: resourceKind, metrics: metricsLookup, nowMs: Date.now() };
      return rows.filter((r) => matchesSmartFilter(r, clauses, ctx));
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => matchesPlainText(r, words, resourceKind));
  }, [rows, deferredFilter, kind, metricsLookup]);

  const rowsById = useMemo(() => new Map(filtered.map((row) => [row.obj.metadata.uid, row])), [filtered]);
  const labelOptions = useMemo(() => labelSelectorOptions(rows), [rows]);
  const labelTerms = useMemo(() => splitLabelSelector(labelSelector ?? ''), [labelSelector]);

  const setTextFilter = (value: string) => {
    setInputValue(value);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      committedRef.current = value;
      if (onFilterChange) onFilterChange(value);
      else setLocalFilter(value);
    }, 250);
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
      const isQuickSearchShortcut = !shortcutModifier && !event.altKey && (key === 's' || key === ':' || key === '/');
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
        <SmartFilterInput
          value={inputValue}
          onChange={setTextFilter}
          kind={kind ?? 'Resource'}
          rows={rows}
          inputRef={searchInputRef}
        />
        {onLabelSelectorChange && (
          <Autocomplete<string, true, false, true>
            multiple
            freeSolo
            disableCloseOnSelect
            limitTags={2}
            options={labelOptions.terms}
            value={labelTerms}
            filterOptions={labelFilterOptions}
            onChange={(_event, values) => onLabelSelectorChange(joinLabelSelector(values))}
            renderOption={({ key, ...props }, option, { selected }) => (
              <Box component="li" key={key} {...props} sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                <Checkbox size="small" checked={selected} disableRipple sx={{ p: 0, mr: 0.25 }} />
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {option}
                </Typography>
                {labelOptions.keys.has(option) && (
                  <Typography variant="caption" color="text.secondary">
                    key
                  </Typography>
                )}
              </Box>
            )}
            renderValue={(values, getItemProps) =>
              values.map((option, index) => {
                const { key, ...itemProps } = getItemProps({ index });
                return <Chip key={key} {...itemProps} label={option} size="small" />;
              })
            }
            renderInput={(params) => <TextField {...params} placeholder={labelTerms.length ? undefined : 'Labels'} />}
            sx={{ width: 320 }}
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
