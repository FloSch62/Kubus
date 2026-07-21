import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { gvkForKind, type KubeObject } from '@kubus/shared';
import { useApiResourcesForContexts, useWatchedList, type ClusterRow } from '../api/queries.js';
import { matchesPlainText, matchesSmartFilter, parseSmartFilter } from '../smart-filter.js';
import { namespaceVisible, useClustersStore } from '../state/clusters.js';
import { useDetailStore } from '../state/detail.js';
import { AgeCell } from '../components/AgeCell.js';
import { copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { useQuickSearchShortcut } from '../components/quick-search.js';
import { SmartFilterInput } from '../components/SmartFilterInput.js';
import { StatusChip } from '../components/StatusChip.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { countLabel } from '../components/format.js';

interface EventObj extends KubeObject {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string | null;
  firstTimestamp?: string | null;
  eventTime?: string | null;
  series?: { count?: number; lastObservedTime?: string | null };
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string; apiVersion?: string };
}

interface EventRow {
  id: string;
  ctx: string;
  ev: EventObj;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
}

// Hoisted: the grid re-renders on every watch tick, and fresh sx/getRowId
// identities would make it redo emotion serialization and prop-keyed work.
const eventsGridSx = {
  border: 0,
  flex: 1,
  minHeight: 0,
  '& .MuiDataGrid-row': { cursor: 'pointer' },
  ...copyCellGridSx,
};
const eventsGridInitialState = { sorting: { sortModel: [{ field: 'lastSeen', sort: 'desc' as const }] } };
const getEventRowId = (r: EventRow) => r.id;

function maxTime(...ts: Array<string | null | undefined>): string | undefined {
  return ts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .at(-1);
}

function minTime(...ts: Array<string | null | undefined>): string | undefined {
  return ts
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .at(0);
}

/** Merge repeated events: same cluster, involved object, reason and message. */
function dedupe(rows: ClusterRow[]): EventRow[] {
  const out = new Map<string, EventRow>();
  for (const { ctx, obj } of rows) {
    const ev = obj as EventObj;
    const target = ev.involvedObject?.uid ?? `${ev.involvedObject?.kind}/${ev.involvedObject?.namespace}/${ev.involvedObject?.name}`;
    const key = `${ctx}|${target}|${ev.reason ?? ''}|${ev.message ?? ''}`;
    const count = ev.count ?? ev.series?.count ?? 1;
    const last = maxTime(ev.lastTimestamp, ev.eventTime, ev.series?.lastObservedTime, obj.metadata.creationTimestamp);
    const first = minTime(ev.firstTimestamp, ev.eventTime, obj.metadata.creationTimestamp);
    const existing = out.get(key);
    if (!existing) {
      out.set(key, { id: key, ctx, ev, count, firstSeen: first, lastSeen: last });
    } else {
      // Distinct event objects under the same key (each uid appears once per
      // snapshot) — their counts add up.
      existing.count += count;
      existing.firstSeen = minTime(existing.firstSeen, first);
      const newer = maxTime(existing.lastSeen, last) === last;
      existing.lastSeen = maxTime(existing.lastSeen, last);
      if (newer) existing.ev = ev;
    }
  }
  return [...out.values()];
}

export function EventsPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const list = useWatchedList(selected, '', 'v1', 'events');
  const openDetail = useDetailStore((s) => s.open);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [kindFilter, setKindFilter] = useState('');
  const [text, setText] = useState('');
  const deferredText = useDeferredValue(text);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useQuickSearchShortcut(searchInputRef);

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
    if (namespaces.length > 0) {
      filtered = filtered.filter((r) => namespaceVisible(r.obj.metadata.namespace, namespaces));
    }
    if (parsedFilter?.clauses) {
      const ctx = { kind: 'Event', nowMs: Date.now() };
      filtered = filtered.filter((r) => matchesSmartFilter(r, parsedFilter.clauses, ctx));
    } else if (parsedFilter?.words) {
      filtered = filtered.filter((r) => matchesPlainText(r, parsedFilter.words, 'Event'));
    }
    return dedupe(filtered);
  }, [list.rows, namespaces, parsedFilter]);

  const rows = useMemo(() => {
    if (!warningsOnly && !kindFilter) return deduped;
    return deduped.filter((r) => {
      if (warningsOnly && r.ev.type !== 'Warning') return false;
      if (kindFilter && r.ev.involvedObject?.kind !== kindFilter) return false;
      return true;
    });
  }, [deduped, warningsOnly, kindFilter]);

  const openInvolved = useCallback(
    (row: EventRow) => {
      const o = row.ev.involvedObject;
      if (!o?.kind || !o.name) return;
      // Resolve the GVR from discovery (covers CRDs), falling back to builtins.
      const apiVersion = o.apiVersion ?? '';
      const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion || 'v1'];
      const fromDiscovery = (apiResources?.byContext[row.ctx] ?? []).find((r) => r.kind === o.kind && r.group === (group ?? '') && (!version || r.version === version));
      const gvk = fromDiscovery ?? gvkForKind(o.kind);
      if (!gvk) return;
      openDetail({
        ctx: row.ctx,
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

  const onRowClick = useCallback((p: { row: EventRow }) => openInvolved(p.row), [openInvolved]);
  const onCellKeyDown = useCallback<NonNullable<React.ComponentProps<typeof DataGrid<EventRow>>['onCellKeyDown']>>(
    (params, event, details) => {
      handleCopyCellKeyDown(params, event, details);
      // Keyboard equivalent of clicking the row.
      if (event.key === 'Enter') {
        event.preventDefault();
        openInvolved(params.row);
      }
    },
    [openInvolved],
  );

  const columns: GridColDef<EventRow>[] = useMemo(() => {
    const defs: GridColDef<EventRow>[] = [
      {
        field: 'type',
        headerName: 'Type',
        width: 90,
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
      ...(selected.length > 1
        ? [{ field: 'cluster', headerName: 'Cluster', width: 140, valueGetter: (_v: unknown, row: EventRow) => row.ctx } satisfies GridColDef<EventRow>]
        : []),
      { field: 'count', headerName: 'Count', width: 70, type: 'number', valueGetter: (_v, row) => row.count },
      {
        field: 'firstSeen',
        headerName: 'First seen',
        width: 95,
        valueGetter: (_v, row) => row.firstSeen ?? '',
        renderCell: (p) => <AgeCell timestamp={p.row.firstSeen} />,
      },
      {
        field: 'lastSeen',
        headerName: 'Last seen',
        width: 95,
        valueGetter: (_v, row) => row.lastSeen ?? '',
        renderCell: (p) => <AgeCell timestamp={p.row.lastSeen} />,
      },
    ];
    return defs.map(withCellCopy);
  }, [selected.length]);

  const grid = useGridPrefs('events', columns);

  if (selected.length === 0) {
    return <NoClustersState icon={<NotificationsNoneOutlinedIcon />} />;
  }

  const errors = Object.entries(list.status).filter(([, s]) => s.state === 'error');
  const reconnecting = Object.entries(list.status).filter(([, s]) => s.state === 'reconnecting');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box sx={{ px: 1.5, pt: 1.5 }}>
        <PageHeader title="Events" icon={<NotificationsNoneOutlinedIcon />}>
          <Chip label={countLabel(rows.length, 'event')} variant="outlined" />
        </PageHeader>
        {errors.map(([ctx, s]) => (
          <Alert key={ctx} severity="error" sx={{ mt: 0.5 }}>
            {ctx}: {s.message ?? 'watch error'}
          </Alert>
        ))}
        {reconnecting.map(([ctx]) => (
          <Alert key={ctx} severity="warning" sx={{ mt: 0.5 }}>
            {ctx}: connection lost — reconnecting, events may be stale.
          </Alert>
        ))}
      </Box>
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, flexShrink: 0, alignItems: 'center' }}>
        <SmartFilterInput value={text} onChange={setText} kind="Event" rows={list.rows} inputRef={searchInputRef} />
        <FormControl size="small" sx={{ minWidth: 160 }}>
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
        <FormControlLabel
          control={<Switch size="small" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)} />}
          label={<Typography variant="body2">Warnings only</Typography>}
        />
      </Stack>
      <DataGrid
        rows={rows}
        columns={grid.columns}
        loading={Object.values(list.status).some((s) => s.state === 'loading')}
        getRowId={getEventRowId}
        density={grid.density}
        onColumnWidthChange={grid.onColumnWidthChange}
        onRowClick={onRowClick}
        onCellKeyDown={onCellKeyDown}
        initialState={eventsGridInitialState}
        sx={eventsGridSx}
      />
    </Box>
  );
}
