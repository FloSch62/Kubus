import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { ResourceButton } from './components.js';
import { configRelations, relatedConfigMaps, type ConfigRelation } from './configmaps.js';
import { key, object, string, type Located } from './model.js';
import { records } from './runtime.js';
import type { Lab } from './labs.js';

export function Files({
  labs,
  nodes,
  pods,
  maps,
  onNode,
  loading,
}: {
  labs: Lab[];
  nodes: Located[];
  pods: Located[];
  maps: Located[];
  onNode: (n: Located) => void;
  loading: boolean;
}) {
  const [view, setView] = useState('Device files');
  const [search, setSearch] = useState('');
  const [shared, setShared] = useState(false);
  const relations = useMemo(() => configRelations(nodes, pods, maps), [nodes, pods, maps]);
  const allMaps = useMemo(() => relatedConfigMaps(labs, relations, maps), [labs, relations, maps]);
  const rows = relations.filter(
    (r) =>
      r.source === view &&
      (shared || !['Peer directory', 'Mounted ConfigMap'].includes(r.purpose)) &&
      `${r.name} ${r.node.metadata.name} ${r.node.metadata.namespace} ${r.path} ${r.destination ?? ''} ${r.dataKey} ${r.purpose}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const otherInputs = nodes.reduce((sum, n) => sum + records(n.spec?.filesFromSecret).length + records(n.spec?.filesFromURL).length, 0);
  const columns = useMemo<GridColDef<ConfigRelation>[]>(
    () => [
      {
        field: 'node',
        headerName: 'Device',
        width: 120,
        valueGetter: (_, r) => r.node.metadata.name,
        renderCell: ({ row }) => <Button onClick={() => onNode(row.node)}>{row.node.metadata.name}</Button>,
      },
      {
        field: 'purpose',
        headerName: 'Purpose',
        width: 140,
        renderCell: ({ value }) => (
          <Typography variant="caption" sx={{ whiteSpace: 'normal', lineHeight: 1.4 }}>
            {String(value)}
          </Typography>
        ),
      },
      {
        field: 'name',
        headerName: 'ConfigMap / data key',
        minWidth: 260,
        flex: 1,
        renderCell: ({ row }) => (
          <Stack sx={{ minWidth: 0 }}>
            {row.map ? <ResourceButton resource={row.map}>{row.name}</ResourceButton> : row.name}
            <Tooltip title={row.dataKey}>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ px: 0.75 }}>
                {row.dataKey}
              </Typography>
            </Tooltip>
          </Stack>
        ),
      },
      {
        field: 'path',
        headerName: view === 'Device files' ? 'Device destination / staged source' : 'Pod mount path',
        minWidth: 270,
        flex: 1,
        valueGetter: (_, r) => r.destination ?? r.path,
        renderCell: ({ row }) => (
          <Tooltip title={row.destination && row.destination !== row.path ? `${row.path} → ${row.destination}` : row.path}>
            <Stack sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {row.destination ?? row.path}
              </Typography>
              {row.destination && row.destination !== row.path && (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {row.path}
                </Typography>
              )}
            </Stack>
          </Tooltip>
        ),
      },
      {
        field: 'state',
        headerName: 'State',
        width: 120,
        renderCell: ({ value }) => (
          <Chip
            size="small"
            variant="outlined"
            color={value === 'Map unavailable' || value === 'Key missing' ? 'warning' : 'default'}
            label={String(value)}
          />
        ),
      },
      { field: 'namespace', headerName: 'Lab namespace', width: 140, valueGetter: (_, r) => r.node.metadata.namespace },
      ...(new Set(nodes.map((n) => n.ctx)).size > 1
        ? [{ field: 'ctx', headerName: 'Cluster', width: 180, valueGetter: (_: unknown, r: ConfigRelation) => r.node.ctx }]
        : []),
    ],
    [view, onNode, nodes],
  );
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', px: 1.5, gap: 2, flexWrap: 'wrap' }}>
        <Tabs value={view} onChange={(_, v: string) => setView(v)} aria-label="Configuration file views">
          {['Device files', 'Runtime artifacts', 'ConfigMaps'].map((v) => (
            <Tab key={v} label={v} value={v} />
          ))}
        </Tabs>
        {view === 'Runtime artifacts' && (
          <Button size="small" aria-pressed={shared} onClick={() => setShared((v) => !v)}>
            {shared ? 'Hide shared mounts' : 'Include shared mounts'}
          </Button>
        )}
        <TextField
          size="small"
          label="Find file or ConfigMap"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ ml: 'auto', width: 240, my: 1 }}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
        {view === 'Device files'
          ? 'Trace startup configurations and bound files from their ConfigMap key to the device. These are declared inputs; saved running configuration lives on the device or its persistent volume.'
          : view === 'Runtime artifacts'
            ? 'Mounted maps are the Pod’s active inputs. Unmounted plans and planner outputs remain visible for troubleshooting; their presence does not mean they are applied.'
            : 'ConfigMaps related by device references, Pod mounts or Topology ownership. Open one to inspect its content, usage and YAML in Kubus.'}
      </Typography>
      {!!otherInputs && view === 'Device files' && (
        <Alert severity="info" sx={{ mx: 2, mb: 1 }}>
          {otherInputs} additional Secret or URL file reference(s) are declared. Open the device’s Files tab for their destination paths;
          Secret contents are not read.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 200 }}>
        {view === 'ConfigMaps' ? (
          <DataGrid
            density="compact"
            disableRowSelectionOnClick
            rows={allMaps.filter((m) => `${m.metadata.name} ${m.metadata.namespace}`.toLowerCase().includes(search.toLowerCase()))}
            getRowId={key}
            loading={loading}
            aria-label="Related ConfigMaps"
            columns={[
              {
                field: 'name',
                headerName: 'ConfigMap',
                minWidth: 240,
                flex: 1,
                valueGetter: (_, m) => m.metadata.name,
                renderCell: ({ row }) => <ResourceButton resource={row}>{row.metadata.name}</ResourceButton>,
              },
              {
                field: 'keys',
                headerName: 'Data keys',
                minWidth: 200,
                flex: 1,
                valueGetter: (_, m) => Object.keys({ ...object(m.data), ...object(m.binaryData) }).join(', '),
              },
              {
                field: 'devices',
                headerName: 'Used by devices',
                minWidth: 190,
                flex: 1,
                valueGetter: (_, m) =>
                  [...new Set(relations.filter((r) => r.map && key(r.map) === key(m)).map((r) => r.node.metadata.name))].join(', ') ||
                  'Topology owned',
              },
              { field: 'immutable', headerName: 'Immutable', width: 95, valueGetter: (_, m) => (m.immutable ? 'Yes' : 'No') },
              { field: 'namespace', headerName: 'Namespace', width: 140, valueGetter: (_, m) => m.metadata.namespace },
              { field: 'ctx', headerName: 'Cluster', width: 180 },
            ]}
          />
        ) : (
          <DataGrid
            density="compact"
            disableRowSelectionOnClick
            rows={rows}
            rowHeight={76}
            columns={columns}
            loading={loading}
            aria-label="Device configuration files"
            getRowId={(r) => r.id}
            sx={{ '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' } }}
          />
        )}
      </Box>
    </Stack>
  );
}

function RelationCard({ relation: r }: { relation: ConfigRelation }) {
  return (
    <Box sx={{ p: 1.25, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="subtitle2">{r.purpose}</Typography>
      {r.map ? (
        <ResourceButton resource={r.map}>{r.name}</ResourceButton>
      ) : (
        <Typography color="warning.main" variant="body2">
          {r.name} · {r.state}
        </Typography>
      )}
      <Typography variant="caption" component="p" sx={{ overflowWrap: 'anywhere' }}>
        {r.dataKey} → {r.path || '—'}
      </Typography>
      {r.destination && r.destination !== r.path && (
        <Typography variant="body2" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
          Device: {r.destination}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        {r.source === 'Device files' ? r.state : `${r.state}${r.pod ? ` · ${r.pod.metadata.name}` : ''}`}
      </Typography>
    </Box>
  );
}
export function NodeFiles({ node, pods, maps }: { node: Located; pods: Located[]; maps: Located[] }) {
  const relations = configRelations([node], pods, maps);
  const runtime = relations.filter((r) => r.source === 'Runtime artifacts');
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        ConfigMap → data key → staged file → device. Startup input is distinct from configuration saved on the running device.
      </Typography>
      {relations
        .filter((r) => r.source === 'Device files')
        .map((r) => (
          <RelationCard key={r.id} relation={r} />
        ))}
      {records(node.spec?.filesFromSecret).map((f, i) => (
        <Alert key={`secret${i}`} severity="info">
          Secret reference {string(f.secretName)} → {string(f.filePath)}. Contents are not read.
        </Alert>
      ))}
      {records(node.spec?.filesFromURL).map((f, i) => (
        <Alert key={`url${i}`} severity="info">
          URL payload → {string(f.filePath)}. Inspect the Node for source and integrity settings.
        </Alert>
      ))}
      {!!runtime.length && (
        <Box component="details">
          <summary>Runtime artifacts · {runtime.length}</summary>
          <Stack spacing={1} sx={{ mt: 1 }}>
            {runtime.map((r) => (
              <RelationCard key={r.id} relation={r} />
            ))}
          </Stack>
        </Box>
      )}
      {!relations.length && (
        <Typography variant="body2" color="text.secondary">
          No ConfigMap file references or mounted runtime maps visible.
        </Typography>
      )}
    </Stack>
  );
}
