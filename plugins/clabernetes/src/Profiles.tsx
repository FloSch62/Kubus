import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { useMemo } from 'react';
import { Empty, ResourceButton, gridProps } from './components.js';
import { object, string, type Located } from './model.js';
export function Profiles({ profiles, nodes }: { profiles: Located[]; nodes: Located[] }) {
  const columns = useMemo<GridColDef<Located>[]>(
    () => [
      {
        field: 'name',
        headerName: 'Profile',
        minWidth: 170,
        flex: 1,
        valueGetter: (_, p) => p.metadata.name,
        renderCell: ({ row }) => <ResourceButton resource={row}>{row.metadata.name}</ResourceButton>,
      },
      { field: 'namespace', headerName: 'Namespace', width: 140, valueGetter: (_, p) => p.metadata.namespace },
      {
        field: 'nodes',
        headerName: 'Nodes',
        width: 70,
        type: 'number',
        valueGetter: (_, p) =>
          nodes.filter(
            (n) => n.ctx === p.ctx && n.metadata.namespace === p.metadata.namespace && object(n.spec?.profileRef).name === p.metadata.name,
          ).length,
      },
      {
        field: 'storage',
        headerName: 'Persistence policy',
        minWidth: 160,
        flex: 1,
        valueGetter: (_, p) => {
          const policy = object(object(p.spec?.deployment).persistence);
          return policy.enabled === true
            ? `Enabled · ${string(policy.reclaim, 'Delete')}`
            : policy.enabled === false
              ? 'Disabled'
              : 'Inherited';
        },
      },
      {
        field: 'management',
        headerName: 'Management subnet',
        width: 180,
        valueGetter: (_, p) => string(object(p.spec?.mgmt)['ipv4-subnet'], 'Inherited'),
      },
      {
        field: 'exposure',
        headerName: 'Exposure',
        width: 130,
        valueGetter: (_, p) => string(object(p.spec?.expose).exposeType, 'Inherited'),
      },
      { field: 'revision', headerName: 'Revision', width: 80, type: 'number', valueGetter: (_, p) => p.metadata.generation },
      { field: 'ctx', headerName: 'Cluster', width: 190 },
    ],
    [nodes],
  );
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Shared Pod policy for devices in the same namespace. Open a profile to inspect or edit resources, scheduling, image pulls,
        persistence and probes.
      </Typography>
      {profiles.length ? (
        <Box sx={{ flex: 1, minHeight: 200 }}>
          <DataGrid
            {...gridProps}
            aria-label="Node profiles"
            rows={profiles}
            columns={columns}
            sx={{ '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' } }}
          />
        </Box>
      ) : (
        <Empty title="No Node profiles">Devices may use built-in and supported global defaults.</Empty>
      )}
    </Stack>
  );
}
