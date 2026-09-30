import { READ_ONLY_GRID_SLOTS } from '../components/ResourceGridCell.js';
import { GridTooltips } from '../components/CellTooltip.js';
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { gvkForKind } from '@kubus/shared';
import { useApiResourcesForContexts, useWatchedList } from '../api/queries.js';
import { matchesPlainText, matchesSmartFilter, parseSmartFilter } from '../smart-filter.js';
import { namespaceVisible, useClustersStore } from '../state/clusters.js';
import { useDetailStore } from '../state/detail.js';
import { useEventsPrefsStore, type EventsGrouping, type EventsScope } from '../state/events-prefs.js';
import { AgeCell, useNow } from '../components/AgeCell.js';
import { CellCopyOverlay, copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { useQuickSearchShortcut } from '../components/quick-search.js';
import { SmartFilterInput } from '../components/SmartFilterInput.js';
import { StatusChip } from '../components/StatusChip.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { statusTextColor } from '../theme.js';
import { activityBuckets, dedupeEvents, groupEventsByObject, isWarning, relatedSummary, type EventObj, type EventRow, type ObjectGroup } from './events-model.js';

/** Rows per grid page (the DataGrid default); the footer only shows once there is more than one page. */
const PAGE_SIZE = 100;

// Hoisted: the grid re-renders on every watch tick, and fresh sx/getRowId
// identities would make it redo emotion serialization and prop-keyed work.
const eventsGridSx = {
  border: 0,
  flex: 1,
  minHeight: 0,
  '& .MuiDataGrid-row': { cursor: 'pointer' },
  ...copyCellGridSx,
};
const groupedGridSx = {
  ...eventsGridSx,
  // Keeps copyCellGridSx's position: relative, which anchors the copy button.
  '& .MuiDataGrid-cell': { ...copyCellGridSx['& .MuiDataGrid-cell'], py: 0.75, display: 'flex', alignItems: 'center' },
};
const eventsGridInitialState = { sorting: { sortModel: [{ field: 'lastSeen', sort: 'desc' as const }] } };
const getEventRowId = (r: EventRow) => r.id;
const getGroupRowId = (r: ObjectGroup) => r.id;
const autoRowHeight = () => 'auto' as const;

/** Estimated activity over the last hour as tiny bars. */
function ActivitySparkline({ events, warning }: { events: EventRow[]; warning: boolean }) {
  const theme = useTheme();
  const now = useNow();
  const values = activityBuckets(events, now);
  const max = Math.max(...values);
  const color = warning ? theme.palette.warning.main : theme.palette.text.secondary;
  const bar = 5;
  const gap = 2;
  const height = 18;
  return (
    <Tooltip title="Last hour, estimated from each event's first and last occurrence">
      <Box component="svg" width={values.length * (bar + gap)} height={height} aria-label="Activity in the last hour" sx={{ display: 'block' }}>
        <rect x={0} y={height - 1} width={values.length * (bar + gap) - gap} height={1} fill={theme.palette.divider} />
        {values.map((v, i) => {
          if (v <= 0 || max <= 0) return null;
          const h = Math.max(2, Math.round((v / max) * (height - 3)));
          return <rect key={i} x={i * (bar + gap)} y={height - 1 - h} width={bar} height={h} rx={1} fill={color} />;
        })}
      </Box>
    </Tooltip>
  );
}

function ObjectCell({ group, multiCluster, onOpen }: { group: ObjectGroup; multiCluster: boolean; onOpen: () => void }) {
  const o = group.object;
  const detail = [o.kind, o.namespace, multiCluster ? group.ctx : undefined].filter(Boolean).join(' · ');
  return (
    <Box sx={{ minWidth: 0 }}>
      <Link
        component="button"
        underline="hover"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onOpen();
        }}
        sx={{ fontWeight: 600, fontSize: 13, textAlign: 'left', wordBreak: 'break-all', display: 'block' }}
      >
        {o.name ?? '(unknown)'}
      </Link>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {detail}
      </Typography>
    </Box>
  );
}

function LatestCell({ group }: { group: ObjectGroup }) {
  const ev = group.latest.ev;
  const warning = isWarning(group.latest);
  const related = relatedSummary(group.related);
  return (
    <Box sx={{ minWidth: 0, whiteSpace: 'normal', lineHeight: 1.45 }}>
      <Typography variant="body2" component="span" sx={{ fontWeight: 600, color: warning ? statusTextColor('warning') : 'text.primary', mr: 0.75 }}>
        {ev.reason || 'Event'}
      </Typography>
      <Typography variant="body2" component="span" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
        {ev.message}
      </Typography>
      {related && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', opacity: 0.85 }}>
          Also: {related}
        </Typography>
      )}
    </Box>
  );
}

export function EventsPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespacesByContext = useClustersStore((s) => s.namespacesByContext);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const list = useWatchedList(selected, '', 'v1', 'events');
  const openDetail = useDetailStore((s) => s.open);
  const scope = useEventsPrefsStore((s) => s.scope);
  const grouping = useEventsPrefsStore((s) => s.grouping);
  const setScope = useEventsPrefsStore((s) => s.setScope);
  const setGrouping = useEventsPrefsStore((s) => s.setGrouping);
  const [kindFilter, setKindFilter] = useState('');
  const [text, setText] = useState('');
  const deferredText = useDeferredValue(text);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gridRootRef = useRef<HTMLDivElement>(null);
  useQuickSearchShortcut(searchInputRef);
  const multiCluster = selected.length > 1;

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const row of list.rows) {
      const k = (row.obj as EventObj).involvedObject?.kind;
      if (k) set.add(k);
    }
    return [...set].sort();
  }, [list.rows]);

  // Same engine as the resource tables: plain words, or `/` clauses
  // (reason:, message:, type:warning, ns:, cluster:, age>…).
  const parsedFilter = useMemo(() => {
    const query = deferredText.trim();
    if (!query) return undefined;
    if (query.startsWith('/')) {
      const clauses = parseSmartFilter(query.slice(1));
      return clauses.length ? { clauses } : undefined;
    }
    return { words: query.toLowerCase().split(/\s+/).filter(Boolean) };
  }, [deferredText]);

  const deduped = useMemo(() => {
    let filtered = list.rows;
    if (Object.values(namespacesByContext).some((list) => list.length > 0)) {
      // Each cluster keeps its own namespace filter.
      filtered = filtered.filter((r) => {
        const namespaces = namespacesByContext[r.ctx] ?? [];
        return namespaces.length === 0 || namespaceVisible(r.obj.metadata.namespace, namespaces);
      });
    }
    if (parsedFilter?.clauses) {
      const ctx = { kind: 'Event', nowMs: Date.now() };
      filtered = filtered.filter((r) => matchesSmartFilter(r, parsedFilter.clauses, ctx));
    } else if (parsedFilter?.words) {
      filtered = filtered.filter((r) => matchesPlainText(r, parsedFilter.words, 'Event'));
    }
    const rows = dedupeEvents(filtered);
    return kindFilter ? rows.filter((r) => r.ev.involvedObject?.kind === kindFilter) : rows;
  }, [list.rows, namespacesByContext, parsedFilter, kindFilter]);

  const flatRows = useMemo(() => (scope === 'warnings' ? deduped.filter(isWarning) : deduped), [deduped, scope]);
  const warningGroups = useMemo(() => groupEventsByObject(deduped, 'warnings'), [deduped]);
  const allGroups = useMemo(() => groupEventsByObject(deduped, 'all'), [deduped]);
  const groupRows = scope === 'warnings' ? warningGroups : allGroups;

  const openInvolved = useCallback(
    (ctx: string, o: EventObj['involvedObject']) => {
      if (!o?.kind || !o.name) return;
      // Resolve the GVR from discovery (covers CRDs), falling back to builtins.
      const apiVersion = o.apiVersion ?? '';
      const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion || 'v1'];
      const fromDiscovery = (apiResources?.byContext[ctx] ?? []).find((r) => r.kind === o.kind && r.group === (group ?? '') && (!version || r.version === version));
      const gvk = fromDiscovery ?? gvkForKind(o.kind);
      if (!gvk) return;
      openDetail({
        ctx,
        group: gvk.group,
        version: gvk.version,
        plural: gvk.plural,
        kind: o.kind,
        name: o.name,
        namespace: o.namespace,
      });
    },
    [apiResources, openDetail],
  );

  const onFlatRowClick = useCallback((p: { row: EventRow }) => openInvolved(p.row.ctx, p.row.ev.involvedObject), [openInvolved]);
  const onGroupRowClick = useCallback((p: { row: ObjectGroup }) => openInvolved(p.row.ctx, p.row.object), [openInvolved]);
  const onFlatCellKeyDown = useCallback<NonNullable<React.ComponentProps<typeof DataGrid<EventRow>>['onCellKeyDown']>>(
    (params, event, details) => {
      handleCopyCellKeyDown(params, event, details);
      // Keyboard equivalent of clicking the row.
      if (event.key === 'Enter') {
        event.preventDefault();
        openInvolved(params.row.ctx, params.row.ev.involvedObject);
      }
    },
    [openInvolved],
  );
  const onGroupCellKeyDown = useCallback<NonNullable<React.ComponentProps<typeof DataGrid<ObjectGroup>>['onCellKeyDown']>>(
    (params, event, details) => {
      handleCopyCellKeyDown(params, event, details);
      if (event.key === 'Enter') {
        event.preventDefault();
        openInvolved(params.row.ctx, params.row.object);
      }
    },
    [openInvolved],
  );

  const flatColumns: GridColDef<EventRow>[] = useMemo(() => {
    const defs: GridColDef<EventRow>[] = [
      {
        field: 'type',
        headerName: 'Type',
        width: 96,
        valueGetter: (_v, row) => row.ev.type ?? '',
        renderCell: (p) => <StatusChip status={p.row.ev.type ?? ''} />,
      },
      { field: 'reason', headerName: 'Reason', width: 150, valueGetter: (_v, row) => row.ev.reason ?? '' },
      {
        field: 'object',
        headerName: 'Object',
        width: 230,
        valueGetter: (_v, row) => `${row.ev.involvedObject?.kind ?? ''}/${row.ev.involvedObject?.name ?? ''}`,
      },
      { field: 'message', headerName: 'Message', flex: 2, minWidth: 260, valueGetter: (_v, row) => row.ev.message ?? '' },
      { field: 'namespace', headerName: 'Namespace', width: 120, valueGetter: (_v, row) => row.ev.involvedObject?.namespace ?? row.ev.metadata.namespace ?? '' },
      ...(multiCluster ? [{ field: 'cluster', headerName: 'Cluster', width: 140, valueGetter: (_v: unknown, row: EventRow) => row.ctx } satisfies GridColDef<EventRow>] : []),
      { field: 'count', headerName: 'Count', width: 76, type: 'number', valueGetter: (_v, row) => row.count },
      {
        field: 'firstSeen',
        headerName: 'First seen',
        width: 110,
        valueGetter: (_v, row) => row.firstSeen ?? '',
        renderCell: (p) => <AgeCell timestamp={p.row.firstSeen} />,
      },
      {
        field: 'lastSeen',
        headerName: 'Last seen',
        width: 110,
        valueGetter: (_v, row) => row.lastSeen ?? '',
        renderCell: (p) => <AgeCell timestamp={p.row.lastSeen} />,
      },
    ];
    return defs.map(withCellCopy);
  }, [multiCluster]);

  const groupColumns: GridColDef<ObjectGroup>[] = useMemo(() => {
    const defs: GridColDef<ObjectGroup>[] = [
      {
        field: 'object',
        headerName: 'Object',
        flex: 1,
        minWidth: 200,
        valueGetter: (_v, row) => row.object.name ?? '',
        renderCell: (p) => <ObjectCell group={p.row} multiCluster={multiCluster} onOpen={() => openInvolved(p.row.ctx, p.row.object)} />,
      },
      {
        field: 'latest',
        headerName: 'Latest',
        flex: 2.6,
        minWidth: 300,
        sortable: false,
        valueGetter: (_v, row) => `${row.latest.ev.reason ?? ''} ${row.latest.ev.message ?? ''}`,
        renderCell: (p) => <LatestCell group={p.row} />,
      },
      { field: 'count', headerName: 'Count', width: 84, type: 'number', valueGetter: (_v, row) => row.count },
      {
        field: 'activity',
        headerName: 'Last hour',
        width: 112,
        sortable: false,
        renderCell: (p) => <ActivitySparkline events={p.row.counted} warning={isWarning(p.row.latest)} />,
      },
      {
        field: 'lastSeen',
        headerName: 'Last seen',
        width: 110,
        valueGetter: (_v, row) => row.lastSeen ?? '',
        renderCell: (p) => <AgeCell timestamp={p.row.lastSeen} />,
      },
    ];
    return defs.map(withCellCopy);
  }, [multiCluster, openInvolved]);

  const flatGrid = useGridPrefs('events', flatColumns);
  const groupGrid = useGridPrefs('events-grouped', groupColumns);

  if (selected.length === 0) {
    return <NoClustersState icon={<NotificationsNoneOutlinedIcon />} />;
  }

  const unit = grouping === 'object' ? 'objects' : 'events';
  const warningTotal = grouping === 'object' ? warningGroups.length : deduped.filter(isWarning).length;
  const allTotal = grouping === 'object' ? allGroups.length : deduped.length;
  const loading = Object.values(list.status).some((s) => s.state === 'loading');
  const shownCount = grouping === 'object' ? groupRows.length : flatRows.length;
  const emptyText =
    scope === 'warnings' ? 'No warnings. Switch to All to see every event.' : text || kindFilter ? 'No events match these filters.' : 'No events.';

  return (
    <Box ref={gridRootRef} sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box sx={{ px: 1.5, pt: 1.5 }}>
        <PageHeader title="Events" icon={<NotificationsNoneOutlinedIcon />}>
          <Box sx={{ flex: 1 }} />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={scope}
            onChange={(_e, value: EventsScope | null) => value && setScope(value)}
            aria-label="Which events to show"
          >
            <ToggleButton value="warnings" sx={{ px: 1.25, gap: 0.75 }}>
              Warnings
              <Box component="span" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                {warningTotal.toLocaleString()} {unit}
              </Box>
            </ToggleButton>
            <ToggleButton value="all" sx={{ px: 1.25, gap: 0.75 }}>
              All
              <Box component="span" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                {allTotal.toLocaleString()}
              </Box>
            </ToggleButton>
          </ToggleButtonGroup>
        </PageHeader>
      </Box>
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, flexShrink: 0, alignItems: 'center' }}>
        <SmartFilterInput value={text} onChange={setText} kind="Event" rows={list.rows} inputRef={searchInputRef} />
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel id="events-kind">Kind</InputLabel>
          <Select labelId="events-kind" label="Kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <MenuItem value="">All kinds</MenuItem>
            {kinds.map((k) => (
              <MenuItem key={k} value={k}>
                {k}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <Select
            value={grouping}
            onChange={(e) => setGrouping(e.target.value as EventsGrouping)}
            inputProps={{ 'aria-label': 'View' }}
          >
            <MenuItem value="object">Group by object</MenuItem>
            <MenuItem value="flat">Flat event log</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      <GridTooltips rootRef={gridRootRef}>
        {grouping === 'object' ? (
          <DataGrid
            key="grouped"
            slots={READ_ONLY_GRID_SLOTS}
            rowBufferPx={160}
            columnBufferPx={50}
            rows={groupRows}
            columns={groupGrid.columns}
            loading={loading}
            getRowId={getGroupRowId}
            getRowHeight={autoRowHeight}
            getEstimatedRowHeight={() => 64}
            density={groupGrid.density}
            onColumnWidthChange={groupGrid.onColumnWidthChange}
            onRowClick={onGroupRowClick}
            onCellKeyDown={onGroupCellKeyDown}
            initialState={eventsGridInitialState}
            hideFooter={shownCount <= PAGE_SIZE}
            localeText={{ noRowsLabel: emptyText }}
            sx={groupedGridSx}
          />
        ) : (
          <DataGrid
            key="flat"
            slots={READ_ONLY_GRID_SLOTS}
            rowBufferPx={80}
            columnBufferPx={50}
            rows={flatRows}
            columns={flatGrid.columns}
            loading={loading}
            getRowId={getEventRowId}
            density={flatGrid.density}
            onColumnWidthChange={flatGrid.onColumnWidthChange}
            onRowClick={onFlatRowClick}
            onCellKeyDown={onFlatCellKeyDown}
            initialState={eventsGridInitialState}
            hideFooter={shownCount <= PAGE_SIZE}
            localeText={{ noRowsLabel: emptyText }}
            sx={eventsGridSx}
          />
        )}
      </GridTooltips>
      <CellCopyOverlay rootRef={gridRootRef} />
    </Box>
  );
}
