import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import { layout, statusTextColor } from '../theme.js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { READ_ONLY_GRID_SLOTS } from './ResourceGridCell.js';
import { GridTooltips } from './CellTooltip.js';
import { DataGrid, GRID_CHECKBOX_SELECTION_COL_DEF, useGridApiRef, type GridApi, type GridColDef, type GridColumnVisibilityModel, type GridPaginationModel, type GridRowParams, type GridRowSelectionModel, type GridSortModel } from '@mui/x-data-grid';
import type { ClusterRow } from '../api/queries.js';
import { matchesPlainText, matchesSmartFilter, parseSmartFilter } from '../smart-filter.js';
import { joinLabelSelector, splitLabelSelector } from '../label-selector.js';
import { nameColumnCap, nameColumnWidth } from './name-width.js';
import { SmartFilterInput } from './SmartFilterInput.js';
import { CellCopyOverlay, copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from './CellCopy.js';
import { withNaturalSort } from './natural-sort.js';
import type { MetricsLookup } from './columns.js';
import { podSummary } from '../kube-display.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { useQuickSearchShortcut } from './quick-search.js';
import { countLabel } from './format.js';
import { handleGridRowKey } from './grid-row-keys.js';
import type { RowKeyAction } from '../row-keys.js';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import FilterAltOffOutlinedIcon from '@mui/icons-material/FilterAltOffOutlined';
import SchemaOutlinedIcon from '@mui/icons-material/SchemaOutlined';

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
  /** Drop the text filter and label selector in one step (the empty state's Clear button). */
  onClearFilters?: () => void;
  /** Custom kinds: the empty state links to the backing CRD. */
  onOpenDefinition?: () => void;
  onRowClick?: (row: ClusterRow) => void;
  /** Keyboard activation (Enter on a cell); lets pages move focus along. */
  onRowActivate?: (row: ClusterRow) => void;
  /** Opened by right-click or the ContextMenu / Shift+F10 keys. */
  onRowContextMenu?: (row: ClusterRow, position: { clientX: number; clientY: number }) => void;
  /** A single-key action on the focused row (L, X, F, S, R, E, Del); returns whether the row has it. */
  onRowKey?: (row: ClusterRow, action: RowKeyAction) => boolean;
  /**
   * Page header rendered above the toolbar, given the row counts so the
   * count can sit next to the title (`shown` after the text filter).
   */
  renderHeader?: (counts: { shown: number; total: number }) => ReactNode;
  /** Extra toolbar elements, right of the search field (columns, views). */
  toolbar?: ReactNode;
  /** Bulk actions for the checked rows, shown on their own row under the toolbar. */
  selectionBar?: ReactNode;
  /** Enable checkbox selection; returns selected rows. */
  onSelectionChange?: (rows: ClusterRow[]) => void;
  /** Controlled checkbox selection, kept in sync with external bulk actions. */
  selectedRows?: ClusterRow[];
  checkboxSelection?: boolean;
  /** Column fields hidden by default (user can re-enable via the column menu). */
  hiddenFields?: string[];
  /** Stable id used to persist user-resized column widths for this table. */
  tableId?: string;
  /** Row emphasized as the resource currently shown in an adjacent detail view. */
  activeRowId?: string;
  /** Remember the scroll position under this key and restore it when the table mounts again. */
  scrollKey?: string;
  /** Lets the page read grid state, e.g. the sorted row order for Copy rows. */
  apiRef?: RefObject<GridApi | null>;
}

const DEFAULT_SORT: GridSortModel = [{ field: 'name', sort: 'asc' }];

const getResourceRowId = (row: ClusterRow) => row.obj.metadata.uid;

const SCROLL_SETTLE_MS = 120;

const TABLE_SX = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } as const;

/** The search field takes the row; the toolbar buttons keep their size. */
const SEARCH_SX = { flex: 1, minWidth: 200, '& .MuiOutlinedInput-root': { minHeight: 34, py: '0 !important' } };

/** The DataGrid (MIT) caps a page at 100 rows. */
const DEFAULT_PAGINATION: GridPaginationModel = { page: 0, pageSize: 100 };

/**
 * Columns every page wide list keeps on screen while it scrolls sideways:
 * the checkbox and Name at the left, the row menu at the right. The MIT grid
 * has no column pinning, so these cells are CSS-sticky inside the scroller
 * (which is why column virtualization is off, see ResourceTable).
 */
function stickyColumnSx(theme: Theme, checkboxes: boolean) {
  const dark = theme.palette.mode === 'dark';
  // The grid's own surface color, so sticky cells match the rows they cover.
  const paper = 'var(--DataGrid-t-color-background-base)';
  const tint = (color: string) => ({ backgroundImage: `linear-gradient(${color}, ${color})` });
  const cells = (field: string) => `& .MuiDataGrid-cell[data-field="${field}"], & .MuiDataGrid-columnHeader[data-field="${field}"]`;
  const sticky = { position: 'sticky', zIndex: 3, backgroundColor: paper };
  const nameLeft = checkboxes ? GRID_CHECKBOX_SELECTION_COL_DEF.width ?? 50 : 0;
  const edge = dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.10)';
  return {
    ...(checkboxes ? { [cells('__check__')]: { ...sticky, left: 0 } } : {}),
    [cells('name')]: { ...sticky, left: nameLeft },
    [cells('_actions')]: { ...sticky, right: 0 },
    // Rows paint their hover/selection tint on the row; opaque sticky cells
    // repeat it so they don't show up as white blocks.
    '& .MuiDataGrid-row:hover .MuiDataGrid-cell[data-field="name"], & .MuiDataGrid-row:hover .MuiDataGrid-cell[data-field="_actions"], & .MuiDataGrid-row:hover .MuiDataGrid-cell[data-field="__check__"]':
      tint(dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'),
    '& .MuiDataGrid-row.Mui-selected .MuiDataGrid-cell[data-field="name"], & .MuiDataGrid-row.Mui-selected .MuiDataGrid-cell[data-field="_actions"], & .MuiDataGrid-row.Mui-selected .MuiDataGrid-cell[data-field="__check__"]':
      tint(dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)'),
    // Soft edges once content scrolls underneath.
    '&.kubus-scrolled-x .MuiDataGrid-cell[data-field="name"], &.kubus-scrolled-x .MuiDataGrid-columnHeader[data-field="name"]': { boxShadow: `6px 0 6px -6px ${edge}` },
    '&.kubus-more-x .MuiDataGrid-cell[data-field="_actions"], &.kubus-more-x .MuiDataGrid-columnHeader[data-field="_actions"]': { boxShadow: `-6px 0 6px -6px ${edge}` },
  };
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
  onClearFilters,
  onOpenDefinition,
  onRowClick,
  onRowActivate,
  onRowContextMenu,
  onRowKey,
  renderHeader,
  toolbar,
  selectionBar,
  checkboxSelection,
  onSelectionChange,
  selectedRows,
  hiddenFields,
  tableId,
  activeRowId,
  scrollKey,
  apiRef,
}: Props) {
  const tableRef = useRef<HTMLDivElement>(null);
  const ownApiRef = useGridApiRef();
  const gridApiRef = apiRef ?? ownApiRef;
  // Rows stay virtualized; columns don't, so the sticky ones (checkbox, Name,
  // row menu) are in the DOM however far the list is scrolled sideways or
  // down. Lists have tens of columns at most. Runs after the grid's own
  // mount effect, which would otherwise switch column virtualization back on.
  useEffect(() => {
    gridApiRef.current?.unstable_setColumnVirtualization(false);
  }, [gridApiRef]);
  const [localFilter, setLocalFilter] = useState('');
  // The committed value lives in the URL (or localFilter); the input itself is
  // local state so typing never waits on a router round-trip, and the commit
  // is debounced so fast typing doesn't spam history/navigation.
  const committedFilter = filter ?? localFilter;
  const [inputValue, setInputValue] = useState(committedFilter);
  const committedRef = useRef(committedFilter);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // External commits (saved view click, back/forward, clear, a remembered
  // filter restored on navigation) reset the input — unless the user is
  // mid-keystroke with a commit pending, whose value wins once it lands.
  useEffect(() => {
    if (committedFilter !== committedRef.current) {
      committedRef.current = committedFilter;
      if (commitTimer.current === undefined) setInputValue(committedFilter);
    }
  }, [committedFilter]);
  useEffect(() => () => clearTimeout(commitTimer.current), []);

  const hiddenKey = (hiddenFields ?? []).join(',');
  // Visibility and sort are driven straight from the prefs store (keyed by
  // tableId), so instance reuse across tables resolves the right model and
  // external writes — a saved-view restore — apply to a mounted table
  // immediately. A saved model wins per field, but default-hidden columns it
  // has never seen (added after the model was saved) stay hidden. Tables
  // without a tableId fall back to local state.
  const storedVisibility = useUiPrefsStore((s) => (tableId ? s.columnVisibility[tableId] : undefined));
  const setStoredVisibility = useUiPrefsStore((s) => s.setColumnVisibility);
  const [localVisibility, setLocalVisibility] = useState<GridColumnVisibilityModel | undefined>(undefined);
  const visibility = useMemo<GridColumnVisibilityModel>(() => {
    const defaults: GridColumnVisibilityModel = Object.fromEntries(hiddenKey ? hiddenKey.split(',').map((f) => [f, false]) : []);
    const saved = tableId ? storedVisibility : localVisibility;
    return saved ? { ...defaults, ...saved } : defaults;
  }, [tableId, storedVisibility, localVisibility, hiddenKey]);
  const handleVisibilityChange = useCallback(
    (model: GridColumnVisibilityModel) => {
      if (tableId) setStoredVisibility(tableId, model);
      else setLocalVisibility(model);
    },
    [tableId, setStoredVisibility],
  );
  const storedSort = useUiPrefsStore((s) => (tableId ? s.sortModels[tableId] : undefined));
  const setStoredSort = useUiPrefsStore((s) => s.setSortModel);
  const [localSort, setLocalSort] = useState<GridSortModel | undefined>(undefined);
  const sortModel = (tableId ? storedSort : localSort) ?? DEFAULT_SORT;
  const handleSortChange = useCallback(
    (model: GridSortModel) => {
      if (tableId) setStoredSort(tableId, model);
      else setLocalSort(model);
    },
    [tableId, setStoredSort],
  );
  const tableDensity = useUiPrefsStore((s) => s.tableDensity);
  // Retrieve this table's saved column widths (if any)
  const storedWidths = useUiPrefsStore((s) => (tableId ? s.columnWidths[tableId] : undefined));
  // Retrieve the action used to persist a column width
  const setColumnWidth = useUiPrefsStore((s) => s.setColumnWidth);

  // Name is sized to the longest name in the list (capped at a share of the
  // table), so the part that tells rows apart isn't the part that's cut.
  const theme = useTheme();
  const nameFont = `400 ${theme.typography.fontSize}px ${theme.typography.fontFamily}`;
  const wantedNameWidth = useMemo(() => nameColumnWidth(rows, nameFont, 0), [rows, nameFont]);
  const wantedNameWidthRef = useRef(wantedNameWidth);
  wantedNameWidthRef.current = wantedNameWidth;
  // The cap tracks the table width in a ref; a render is only requested when
  // it trims (or stops trimming) the name. Dragging the detail divider resizes
  // the table every frame, and most of those widths don't matter here.
  const nameCapRef = useRef(Number.POSITIVE_INFINITY);
  const [, renderForNameCap] = useState(0);
  useEffect(() => {
    const el = tableRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const cap = nameColumnCap(entry?.contentRect.width ?? 0);
      const previous = nameCapRef.current;
      nameCapRef.current = cap;
      const wanted = wantedNameWidthRef.current;
      if (cap !== previous && (cap < wanted || previous < wanted)) renderForNameCap((n) => n + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const nameWidth = Math.min(wantedNameWidth, nameCapRef.current);

  // The copy-button wrapper is cached per column def so columns whose def did
  // not change keep their identity across rebuilds (metrics polls swap only
  // the metric columns) — the grid then skips re-rendering unchanged cells.
  const wrappedColumnsRef = useRef(new WeakMap<GridColDef<ClusterRow>, { width: number | undefined; minWidth: number | undefined; wrapped: GridColDef<ClusterRow> }>());
  const gridColumns = useMemo(() => {
    const cache = wrappedColumnsRef.current;
    return columns.map((column) => {
      const stored = storedWidths?.[column.field];
      // A width the user dragged wins over the measured one.
      const minWidth = column.field === 'name' && stored === undefined ? Math.max(column.minWidth ?? 0, nameWidth) : undefined;
      let entry = cache.get(column);
      if (!entry || entry.width !== stored || entry.minWidth !== minWidth) {
        // If a saved width exists, apply it on a copy of the column.
        const base = stored !== undefined ? { ...column, width: stored, flex: undefined } : minWidth !== undefined ? { ...column, minWidth } : column;
        // Adds the hover copy button and sets flex display on every column;
        // text columns sort naturally (worker-2 before worker-10).
        entry = { width: stored, minWidth, wrapped: withCellCopy(withNaturalSort(base)) };
        cache.set(column, entry);
      }
      return entry.wrapped;
    });
  }, [columns, storedWidths, nameWidth]);

  // Filter on the deferred value so keystrokes render before the table does.
  const deferredFilter = useDeferredValue(inputValue);
  const parsedFilter = useMemo(() => {
    const query = deferredFilter.trim();
    if (!query) return undefined;
    if (query.startsWith('/')) {
      const clauses = parseSmartFilter(query.slice(1));
      if (!clauses.length) return undefined;
      return { clauses, usesMetrics: clauses.some((c) => c.key === 'cpu' || c.key === 'mem' || c.key === 'memory') };
    }
    return { words: query.toLowerCase().split(/\s+/).filter(Boolean) };
  }, [deferredFilter]);
  // Metrics snapshots refresh on a poll; only re-filter for them when a
  // cpu/mem clause actually reads metrics.
  const metricsForFilter = parsedFilter?.usesMetrics ? metricsLookup : undefined;
  const filtered = useMemo(() => {
    if (!parsedFilter) return rows;
    const resourceKind = kind ?? 'Resource';
    const { clauses, words } = parsedFilter;
    if (clauses) {
      const ctx = { kind: resourceKind, metrics: metricsForFilter, nowMs: Date.now() };
      return rows.filter((r) => matchesSmartFilter(r, clauses, ctx));
    }
    return rows.filter((r) => matchesPlainText(r, words ?? [], resourceKind));
  }, [rows, parsedFilter, kind, metricsForFilter]);

  // Kubernetes watches can replace the rows prop every 100 ms. Let those
  // updates accumulate while the virtual scroller is moving so the grid does
  // not re-sort and recycle its visible rows in the middle of a scroll frame.
  // Metric polls replace column renderers too; hold both as one snapshot.
  // The newest snapshot is committed shortly after scrolling settles.
  const scrollingRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [, commitPendingGrid] = useState(0);
  const gridSnapshot = useRef({ rows: filtered, columns: gridColumns });
  if (!scrollingRef.current) gridSnapshot.current = { rows: filtered, columns: gridColumns };
  const { rows: gridRows, columns: displayedColumns } = gridSnapshot.current;
  useEffect(() => {
    const table = tableRef.current;
    const scroller = table?.querySelector<HTMLElement>('.MuiDataGrid-virtualScroller');
    if (!scroller) return;
    const handleScroll = () => {
      scrollingRef.current = true;
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        scrollingRef.current = false;
        commitPendingGrid((epoch) => epoch + 1);
      }, SCROLL_SETTLE_MS);
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    scroller.addEventListener('wheel', handleScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      scroller.removeEventListener('wheel', handleScroll);
      clearTimeout(scrollTimerRef.current);
      scrollingRef.current = false;
    };
  }, []);

  // Scroll memory: the position is saved as the user scrolls (throttled to
  // the settle timer above) and put back once rows exist, so reopening a
  // kind from the nav lands where it was left. Panes that stay mounted keep
  // their own scroll anyway; this covers the fresh mount.
  const scrollRestoredRef = useRef(false);
  const setListState = useUiPrefsStore((s) => s.setListState);
  useEffect(() => {
    scrollRestoredRef.current = false;
  }, [scrollKey]);
  useEffect(() => {
    if (!scrollKey || scrollRestoredRef.current || gridRows.length === 0) return;
    const scroller = tableRef.current?.querySelector<HTMLElement>('.MuiDataGrid-virtualScroller');
    if (!scroller) return;
    scrollRestoredRef.current = true;
    const top = useUiPrefsStore.getState().listState[scrollKey]?.scrollTop;
    if (top) requestAnimationFrame(() => scroller.scrollTo({ top }));
  }, [scrollKey, gridRows.length]);
  useEffect(() => {
    if (!scrollKey) return;
    const scroller = tableRef.current?.querySelector<HTMLElement>('.MuiDataGrid-virtualScroller');
    if (!scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setListState(scrollKey, { scrollTop: Math.round(scroller.scrollTop) || undefined }), 300);
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, [scrollKey, setListState]);

  const rowsById = useMemo(() => new Map(filtered.map((row) => [row.obj.metadata.uid, row])), [filtered]);
  const rowsByIdRef = useRef(rowsById);
  rowsByIdRef.current = rowsById;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const callbacksRef = useRef({ onRowClick, onRowActivate, onRowContextMenu, onRowKey, onSelectionChange });
  callbacksRef.current = { onRowClick, onRowActivate, onRowContextMenu, onRowKey, onSelectionChange };
  const rowSelectionModel = useMemo<GridRowSelectionModel | undefined>(
    () => selectedRows && { type: 'include', ids: new Set(selectedRows.map((row) => row.obj.metadata.uid)) },
    [selectedRows],
  );
  const labelTerms = useMemo(() => splitLabelSelector(labelSelector ?? ''), [labelSelector]);
  const handleLabelTermsChange = useCallback(
    (terms: string[]) => onLabelSelectorChange?.(joinLabelSelector(terms)),
    [onLabelSelectorChange],
  );

  // Page size is tracked so the footer can disappear while one page holds
  // every row: "1–3 of 3" under three rows is noise.
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>(DEFAULT_PAGINATION);

  // The grid re-renders on every watch flush; keep the sx object stable so
  // emotion doesn't re-serialize it each time.
  const gridSx = useMemo(
    () => ({
      border: 0,
      // Sized to its rows, up to the space left; a short list doesn't stretch
      // an empty table down the page.
      flex: '0 1 auto',
      height: 'auto',
      maxHeight: '100%',
      minHeight: 0,
      // Room for the empty state (icon, message, button) when there are no rows.
      '--DataGrid-overlayHeight': '220px',
      '& .MuiDataGrid-row': { cursor: onRowClick ? 'pointer' : 'default' },
      '& .MuiDataGrid-row.kubus-muted-row': { opacity: 0.55, transition: 'opacity 120ms' },
      '& .MuiDataGrid-row.kubus-muted-row:hover, & .MuiDataGrid-row.kubus-muted-row:focus-within': { opacity: 1 },
      // The row cursor: the row holding the focused cell (arrow keys, j/k)
      // gets a thin ring, so single-key row actions have a visible target.
      // Drawn above the sticky cells, which would hide an inset shadow.
      '& .MuiDataGrid-row:focus-within::after': {
        content: '""',
        position: 'absolute',
        inset: 0,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.55)}`,
        pointerEvents: 'none',
        zIndex: 4,
      },
      ...copyCellGridSx,
      ...stickyColumnSx(theme, !!checkboxSelection),
    }),
    [!!onRowClick, theme, !!checkboxSelection], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const setTextFilter = (value: string) => {
    setInputValue(value);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = undefined;
      committedRef.current = value;
      if (onFilterChange) onFilterChange(value);
      else setLocalFilter(value);
    }, 250);
  };

  useQuickSearchShortcut(searchInputRef);

  // Friendlier stand-in for the DataGrid's bare "No rows", telling apart an
  // empty scope from filters hiding everything. A label selector filters
  // server-side — the excluded objects never reach `rows`, so it gets a
  // no-matches message without a hidden count.
  const filteredOut = rows.length - filtered.length;
  const labelFiltered = labelTerms.length > 0;
  const anyFilter = filteredOut > 0 || labelFiltered;
  const clearFiltersRef = useRef<() => void>(() => {});
  clearFiltersRef.current = () => {
    setInputValue('');
    clearTimeout(commitTimer.current);
    commitTimer.current = undefined;
    committedRef.current = '';
    if (onClearFilters) {
      onClearFilters();
      return;
    }
    if (onFilterChange) onFilterChange('');
    else setLocalFilter('');
    onLabelSelectorChange?.('');
  };
  const openDefinitionRef = useRef(onOpenDefinition);
  openDefinitionRef.current = onOpenDefinition;
  const hasDefinition = !!onOpenDefinition;
  const NoRowsOverlay = useCallback(
    () => (
      <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 0.75 }}>
        <InboxOutlinedIcon sx={{ fontSize: 34, color: 'text.secondary', opacity: 0.55 }} />
        <Typography variant="body2" color="text.secondary">
          {filteredOut > 0
            ? `No matches — ${countLabel(filteredOut, 'item')} hidden by the current filters`
            : labelFiltered
              ? 'No matches for the current label selector'
              : // `kind` falls back to the literal 'Resource' for plain custom
                // resources — that would read "No Resource resources".
                kind && kind !== 'Resource'
                ? `No ${kind} resources in the current scope`
                : 'No resources in the current scope'}
        </Typography>
        {anyFilter && (
          <Button size="small" variant="outlined" startIcon={<FilterAltOffOutlinedIcon />} onClick={() => clearFiltersRef.current()} sx={{ pointerEvents: 'auto', mt: 0.5 }}>
            Clear filters
          </Button>
        )}
        {!anyFilter && hasDefinition && (
          <Button size="small" variant="outlined" startIcon={<SchemaOutlinedIcon />} onClick={() => openDefinitionRef.current?.()} sx={{ pointerEvents: 'auto', mt: 0.5 }}>
            Open definition
          </Button>
        )}
      </Stack>
    ),
    [filteredOut, labelFiltered, anyFilter, kind, hasDefinition],
  );
  const slots = useMemo(() => ({ ...READ_ONLY_GRID_SLOTS, noRowsOverlay: NoRowsOverlay }), [NoRowsOverlay]);
  const getRowClassName = useCallback(
    (params: GridRowParams<ClusterRow>) => {
      const classes: string[] = [];
      // Finished pods stay listed (and filterable) but recede visually so
      // the running set stands out; hover restores full contrast.
      if (kind === 'Pod') {
        const status = podSummary(params.row.obj).status;
        if (status === 'Succeeded' || status === 'Completed') classes.push('kubus-muted-row');
      }
      return classes.join(' ');
    },
    [kind],
  );
  const handleRowSelectionChange = useCallback<NonNullable<React.ComponentProps<typeof DataGrid<ClusterRow>>['onRowSelectionModelChange']>>(
    (model) => {
      const onChange = callbacksRef.current.onSelectionChange;
      if (!onChange) return;
      const currentRows = filteredRef.current;
      // The header "select all" checkbox reports an exclude-type model whose
      // ids are the deselected rows.
      const ids = model.ids instanceof Set ? model.ids : new Set();
      const selected =
        model.type === 'exclude'
          ? currentRows.filter((row) => !ids.has(row.obj.metadata.uid))
          : currentRows.filter((row) => ids.has(row.obj.metadata.uid));
      onChange(selected);
    },
    [],
  );
  const handleRowClick = useCallback((params: GridRowParams<ClusterRow>) => callbacksRef.current.onRowClick?.(params.row), []);
  const rowSlotProps = useMemo(
    () => ({
      row: {
        onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
          event.preventDefault();
          event.stopPropagation();
          const id = event.currentTarget.getAttribute('data-id');
          const row = id ? rowsByIdRef.current.get(id) : undefined;
          if (row) callbacksRef.current.onRowContextMenu?.(row, event);
        },
      },
    }),
    [],
  );
  const handleColumnWidthChange = useCallback(
    (params: { colDef: GridColDef<ClusterRow>; width: number }) => {
      if (tableId) setColumnWidth(tableId, params.colDef.field, params.width);
    },
    [tableId, setColumnWidth],
  );
  const handleCellKeyDown = useCallback<NonNullable<React.ComponentProps<typeof DataGrid<ClusterRow>>['onCellKeyDown']>>(
    (params, event, details) => {
      handleCopyCellKeyDown(params, event, details);
      const row = rowsByIdRef.current.get(String(params.id));
      if (!row) return;
      const callbacks = callbacksRef.current;
      if (handleGridRowKey(details.apiRef, params, event, row, callbacks.onRowKey)) return;
      // Keyboard equivalents of clicking and right-clicking a row.
      if (event.key === 'Enter' && (callbacks.onRowActivate || callbacks.onRowClick)) {
        event.preventDefault();
        (callbacks.onRowActivate ?? callbacks.onRowClick)!(row);
      } else if (callbacks.onRowContextMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        const cell = (event.target as HTMLElement | null)?.closest?.('.MuiDataGrid-cell');
        const rect = (cell ?? (event.target as HTMLElement)).getBoundingClientRect();
        callbacks.onRowContextMenu(row, { clientX: rect.left + 8, clientY: rect.bottom - 4 });
      }
    },
    [],
  );

  // Highlighting a different resource changes one CSS rule. Passing a new
  // getRowClassName callback would rebuild every visible row on drawer open.
  const tableSx = useMemo(() => {
    if (!activeRowId) return TABLE_SX;
    const row = `& .MuiDataGrid-row[data-id=${JSON.stringify(activeRowId)}]`;
    const selected = theme.palette.action.selected;
    return {
      ...TABLE_SX,
      [row]: { bgcolor: selected, '&:hover': { bgcolor: selected } },
      // Opaque sticky cells repeat the row's highlight.
      [`${row} .MuiDataGrid-cell[data-field="name"], ${row} .MuiDataGrid-cell[data-field="_actions"], ${row} .MuiDataGrid-cell[data-field="__check__"]`]: {
        backgroundImage: `linear-gradient(${selected}, ${selected})`,
      },
    };
  }, [activeRowId, theme]);

  // Scroll edges for the sticky columns' shadows. Classes on the grid root
  // instead of state: scrolling shouldn't re-render the grid.
  useEffect(() => {
    const root = tableRef.current?.querySelector<HTMLElement>('.MuiDataGrid-root');
    const scroller = root?.querySelector<HTMLElement>('.MuiDataGrid-virtualScroller');
    if (!root || !scroller) return;
    const update = () => {
      root.classList.toggle('kubus-scrolled-x', scroller.scrollLeft > 0);
      root.classList.toggle('kubus-more-x', scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) observer?.observe(content);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [displayedColumns]);

  const hideFooter = filtered.length <= paginationModel.pageSize;
  return (
    <Box ref={tableRef} className="kubus-table" sx={tableSx}>
      {renderHeader?.({ shown: filtered.length, total: rows.length })}
      <Stack direction="row" spacing={1} useFlexGap sx={{ px: 1.5, pt: renderHeader ? 0 : 1, pb: 1, flexShrink: 0, alignItems: 'center' }}>
        <SmartFilterInput
          value={inputValue}
          onChange={setTextFilter}
          kind={kind ?? 'Resource'}
          rows={rows}
          inputRef={searchInputRef}
          labelTerms={onLabelSelectorChange ? labelTerms : undefined}
          onLabelTermsChange={onLabelSelectorChange ? handleLabelTermsChange : undefined}
          sx={SEARCH_SX}
        />
        {statusText && (
          <Typography variant="caption" sx={{ color: statusTextColor('warning') }}>
            {statusText}
          </Typography>
        )}
        {toolbar}
      </Stack>
      {selectionBar}
      <GridTooltips rootRef={tableRef}>
        <DataGrid
          rows={gridRows}
          columns={displayedColumns}
          loading={loading}
          getRowId={getResourceRowId}
          getRowClassName={getRowClassName}
          density={tableDensity === 'comfortable' ? 'standard' : 'compact'}
          // On overlay-scrollbar platforms the grid measures the native
          // scrollbar as 0px and floats its own on top of the last column;
          // an explicit size (matching the themed 10px scrollbars) makes it
          // reserve a real gutter instead.
          scrollbarSize={layout.scrollbarSize}
          rowBufferPx={80}
          columnBufferPx={50}
          checkboxSelection={checkboxSelection}
          rowSelectionModel={rowSelectionModel}
          slots={slots}
          onRowSelectionModelChange={onSelectionChange ? handleRowSelectionChange : undefined}
          disableRowSelectionOnClick={!!checkboxSelection}
          onRowClick={onRowClick ? handleRowClick : undefined}
          slotProps={onRowContextMenu ? rowSlotProps : undefined}
          columnVisibilityModel={visibility}
          onColumnVisibilityModelChange={handleVisibilityChange}
          onColumnWidthChange={tableId ? handleColumnWidthChange : undefined}
          onCellKeyDown={handleCellKeyDown}
          sortModel={sortModel}
          onSortModelChange={handleSortChange}
          paginationModel={paginationModel}
          onPaginationModelChange={setPaginationModel}
          hideFooter={hideFooter}
          apiRef={gridApiRef}
          sx={gridSx}
        />
      </GridTooltips>
      <CellCopyOverlay rootRef={tableRef} />
    </Box>
  );
}
