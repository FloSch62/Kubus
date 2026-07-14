import { useDeferredValue, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { gvkForKind, type KubeObject } from '@kubus/shared';
import { useApiResourcesForContexts, useWatchedList, type ClusterRow } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useDetailStore } from '../state/detail.js';
import { AgeCell } from '../components/AgeCell.js';
import { copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { StatusChip } from '../components/StatusChip.js';
import { EmptyState } from '../components/EmptyState.js';

interface EventObj extends KubeObject {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  firstTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
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

function maxTime(...ts: Array<string | undefined>): string | undefined {
  return ts
    .filter((t): t is string => t !== undefined)
    .sort((a, b) => a.localeCompare(b))
    .at(-1);
}

function minTime(...ts: Array<string | undefined>): string | undefined {
  return ts
    .filter((t): t is string => t !== undefined)
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

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const row of list.rows) {
      const k = (row.obj as EventObj).involvedObject?.kind;
      if (k) set.add(k);
    }
    return [...set].sort();
  }, [list.rows]);

  const deduped = useMemo(() => {
    let filtered = list.rows;
    if (namespaces.length > 0) {
      const nsSet = new Set(namespaces);
      filtered = filtered.filter((r) => !r.obj.metadata.namespace || nsSet.has(r.obj.metadata.namespace));
    }
    return dedupe(filtered);
  }, [list.rows, namespaces]);

  const rows = useMemo(() => {
    const f = deferredText.trim().toLowerCase();
    if (!warningsOnly && !kindFilter && !f) return deduped;
    return deduped.filter((r) => {
      if (warningsOnly && r.ev.type !== 'Warning') return false;
      if (kindFilter && r.ev.involvedObject?.kind !== kindFilter) return false;
      if (f) {
        const o = r.ev.involvedObject;
        return (
          (r.ev.message ?? '').toLowerCase().includes(f) ||
          (r.ev.reason ?? '').toLowerCase().includes(f) ||
          `${o?.kind}/${o?.name}`.toLowerCase().includes(f) ||
          (o?.namespace ?? '').toLowerCase().includes(f) ||
          r.ctx.toLowerCase().includes(f)
        );
      }
      return true;
    });
  }, [deduped, warningsOnly, kindFilter, deferredText]);

  const openInvolved = (row: EventRow) => {
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
  };

  const columns: GridColDef<EventRow>[] = useMemo(() => {
    const defs: GridColDef<EventRow>[] = [
      {
        field: 'type',
        headerName: 'Type',
        width: 90,
        valueGetter: (_v, row) => row.ev.type ?? '',
        renderCell: (p) => <StatusChip status={p.row.ev.type === 'Warning' ? 'Error' : 'Ready'} />,
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

  if (selected.length === 0) {
    return <EmptyState icon={<HubOutlinedIcon />} title="No cluster selected" subtitle="Pick one or more clusters from the switcher in the top bar." />;
  }

  const errors = Object.entries(list.status).filter(([, s]) => s.state === 'error');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box sx={{ px: 1.5, pt: 1.5 }}>
        <Typography variant="h6">Events</Typography>
        {errors.map(([ctx, s]) => (
          <Alert key={ctx} severity="error" sx={{ mt: 0.5 }}>
            {ctx}: {s.message ?? 'watch error'}
          </Alert>
        ))}
      </Box>
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1, flexShrink: 0, alignItems: 'center' }}>
        <TextField
          placeholder="Search message, reason, object…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          sx={{ width: 280 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            },
          }}
        />
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
        <Chip label={`${rows.length} events`} variant="outlined" />
      </Stack>
      <DataGrid
        rows={rows}
        columns={columns}
        loading={Object.values(list.status).some((s) => s.state === 'loading')}
        getRowId={(r) => r.id}
        density="compact"
        onRowClick={(p) => openInvolved(p.row as EventRow)}
        onCellKeyDown={handleCopyCellKeyDown}
        initialState={{ sorting: { sortModel: [{ field: 'lastSeen', sort: 'desc' }] } }}
        sx={{
          border: 0,
          flex: 1,
          minHeight: 0,
          '& .MuiDataGrid-row': { cursor: 'pointer' },
          '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
          ...copyCellGridSx,
        }}
      />
    </Box>
  );
}
