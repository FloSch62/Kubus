import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import InputAdornment from '@mui/material/InputAdornment';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { Badge, gridProps } from './components.js';
import { PodActions } from './PodActions.js';
import { key, object, phase, string, tone, type Located } from './model.js';
import { nodeIssue, nodePods, nodeTargets, records } from './runtime.js';

export function NodeTable({
  nodes,
  pods,
  loading,
  onSelect,
  selected,
  compact = false,
  initialAttention = false,
  onLab,
}: {
  nodes: Located[];
  pods: Located[];
  loading?: boolean;
  onSelect: (node: Located) => void;
  selected?: string;
  compact?: boolean;
  initialAttention?: boolean;
  onLab?: (node: Located) => void;
}) {
  const [search, setSearch] = useState('');
  const [attention, setAttention] = useState(initialAttention);
  const [details, setDetails] = useState(false);
  const count = nodes.filter((n) => tone(phase(n)) !== 'good').length;
  const rows = useMemo(
    () =>
      nodes.filter(
        (n) =>
          (!attention || tone(phase(n)) !== 'good') &&
          `${n.metadata.name} ${n.metadata.namespace} ${n.ctx} ${string(n.spec?.kind)} ${string(n.spec?.image)} ${string(object(n.status?.directManagement).ipv4)}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [nodes, search, attention],
  );
  const runtime = useMemo(
    () => new Map(nodes.map((n) => [key(n), { targets: nodeTargets(n, pods), pod: nodePods(n, pods)[0] }])),
    [nodes, pods],
  );
  const columns = useMemo<GridColDef<Located>[]>(
    () => [
      {
        field: 'name',
        headerName: 'Node',
        minWidth: 130,
        flex: 1,
        valueGetter: (_, n) => n.metadata.name,
        renderCell: ({ row }) => (
          <Button
            sx={{ p: 0, minWidth: 0, fontWeight: 550, textAlign: 'left', justifyContent: 'flex-start' }}
            onClick={() => onSelect(row)}
          >
            {row.metadata.name}
          </Button>
        ),
      },
      {
        field: 'state',
        headerName: 'Status',
        width: 112,
        valueGetter: (_, n) => phase(n),
        renderCell: ({ row }) => (
          <Tooltip title={nodeIssue(row) || 'Controller-reported device readiness'}>
            <Box component="span">
              <Badge value={phase(row)} />
            </Box>
          </Tooltip>
        ),
      },
      { field: 'kind', headerName: 'Kind', width: 155, valueGetter: (_, n) => string(n.spec?.kind) },
      {
        field: 'management',
        headerName: 'Management IP',
        width: 156,
        valueGetter: (_, n) => string(object(n.status?.directManagement).ipv4, string(object(n.status?.directManagement).ipv6)),
        cellClassName: 'mono',
      },
      {
        field: 'restarts',
        headerName: 'Restarts',
        width: 80,
        type: 'number',
        valueGetter: (_, n) => records(n.status?.directContainers).reduce((s, c) => s + Number(c.restartCount ?? 0), 0),
      },
      {
        field: 'worker',
        headerName: 'Worker',
        width: 180,
        valueGetter: (_, n) => string(runtime.get(key(n))?.pod?.spec?.nodeName, 'Not scheduled'),
      },
      {
        field: 'namespace',
        headerName: 'Lab namespace',
        width: 145,
        valueGetter: (_, n) => n.metadata.namespace,
        renderCell: ({ row, value }) =>
          onLab ? (
            <Tooltip title={row.ctx}>
              <Button onClick={() => onLab(row)}>{String(value)}</Button>
            </Tooltip>
          ) : (
            String(value)
          ),
      },
      { field: 'ctx', headerName: 'Cluster', width: 180 },
      { field: 'issue', headerName: 'Readiness detail', minWidth: 210, flex: 1, valueGetter: (_, n) => nodeIssue(n) || '—' },
      {
        field: 'actions',
        headerName: 'Access',
        width: 108,
        sortable: false,
        filterable: false,
        disableColumnMenu: true,
        renderCell: ({ row }) => (
          <PodActions label={row.metadata.name} targets={runtime.get(key(row))?.targets ?? []} compact loading={loading} />
        ),
      },
    ],
    [runtime, onSelect, loading, onLab],
  );
  return (
    <Stack sx={{ minHeight: 0, height: '100%', flex: 1 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', px: 1.5, py: 1, gap: 0.5, flexWrap: 'wrap', borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="subtitle2">Devices</Typography>
        <Chip label={nodes.length} sx={{ height: 20 }} />
        <Chip
          clickable
          variant={attention ? 'filled' : 'outlined'}
          color={count ? 'warning' : 'default'}
          label={`${count} need attention`}
          onClick={() => setAttention((v) => !v)}
          aria-pressed={attention}
          sx={{ height: 24 }}
        />
        {!compact && (
          <Button size="small" onClick={() => setDetails((v) => !v)} aria-pressed={details}>
            Kubernetes details
          </Button>
        )}
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a node…"
          size="small"
          sx={{ ml: 'auto !important', width: 220, '& input': { py: 0.6 } }}
          slotProps={{
            htmlInput: { 'aria-label': 'Find a node' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 17 }} />
                </InputAdornment>
              ),
            },
          }}
        />
      </Stack>
      <Box sx={{ minHeight: 100, flex: 1 }}>
        <DataGrid
          {...gridProps}
          aria-label="Network nodes"
          rows={rows}
          columns={columns}
          rowSelectionModel={{ type: 'include', ids: new Set(selected ? [selected] : []) }}
          columnVisibilityModel={
            compact
              ? { worker: false, namespace: false, ctx: false, issue: false, restarts: false }
              : { worker: details, ctx: details || new Set(nodes.map((n) => n.ctx)).size > 1, issue: details, restarts: details }
          }
          hideFooter={compact}
          rowHeight={36}
          columnHeaderHeight={34}
          onRowDoubleClick={({ row }) => onSelect(row)}
          localeText={{ noRowsLabel: nodes.length ? 'No nodes match your filters' : 'No Node resources in this selection' }}
          sx={{ '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' } }}
        />
      </Box>
    </Stack>
  );
}
