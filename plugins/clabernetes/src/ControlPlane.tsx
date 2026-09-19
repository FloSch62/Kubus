import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { Errors, ResourceButton, Empty, gridProps, Badge } from './components.js';
import { PodActions } from './PodActions.js';
import { useResources } from './useResources.js';
import { type Collection } from './data.js';
import { NODE, OWNER, phase, string, type Located } from './model.js';
import { InstallationDetails } from './Configuration.js';
import { podTargets, records } from './runtime.js';
const collections: Collection[] = [
  { group: '', version: 'v1', plural: 'pods', labelSelector: 'c9s.run/component' },
  { group: 'apps', version: 'v1', plural: 'deployments', labelSelector: 'c9s.run/component=manager' },
  { group: '', version: 'v1', plural: 'configmaps', labelSelector: 'c9s.run/component=config' },
];
export function ControlPlane({ configs, refresh }: { configs: Located[]; refresh: number }) {
  const { snapshot, loading } = useResources(collections, undefined, refresh);
  const pods = snapshot.items.filter(
    (r) =>
      r.plural === 'pods' && !r.metadata.labels?.[OWNER] && !r.metadata.labels?.[NODE] && !r.metadata.labels?.['c9s.run/direct-workload'],
  );
  const isPlanner = (p: Located) => /planner/.test(`${p.metadata.name} ${p.metadata.labels?.['c9s.run/component'] ?? ''}`);
  const planners = pods.filter(isPlanner);
  const ready = (p: Located) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
  const columns = useMemo<GridColDef<Located>[]>(
    () => [
      {
        field: 'name',
        headerName: 'Pod',
        minWidth: 240,
        flex: 1,
        valueGetter: (_, r) => r.metadata.name,
        renderCell: ({ row }) => <ResourceButton resource={row}>{row.metadata.name}</ResourceButton>,
      },
      {
        field: 'role',
        headerName: 'Role',
        width: 140,
        valueGetter: (_, r) => (isPlanner(r) ? 'Planning worker' : string(r.metadata.labels?.['c9s.run/component'], 'Manager')),
      },
      {
        field: 'state',
        headerName: 'Status',
        width: 110,
        valueGetter: (_, r) => (ready(r) ? 'Ready' : phase(r) === 'Running' ? 'Not ready' : phase(r)),
        renderCell: ({ value }) => <Badge value={value as string} />,
      },
      {
        field: 'restarts',
        headerName: 'Restarts',
        width: 80,
        type: 'number',
        valueGetter: (_, r) => records(r.status?.containerStatuses).reduce((n, c) => n + Number(c.restartCount ?? 0), 0),
      },
      { field: 'namespace', headerName: 'Namespace', width: 150, valueGetter: (_, r) => r.metadata.namespace },
      { field: 'ctx', headerName: 'Cluster', width: 180 },
      {
        field: 'actions',
        headerName: 'Access',
        width: 110,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (
          <PodActions
            showShell={false}
            compact
            label={row.metadata.name}
            targets={podTargets(row).map((t) => ({ ...t, role: isPlanner(row) ? 'Planning worker' : 'Controller' }))}
          />
        ),
      },
    ],
    [],
  );
  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Installation & control plane
        </Typography>
        <Chip
          label={planners.length ? `${planners.filter(ready).length}/${planners.length} planners ready` : 'No planning workers observed'}
          variant="outlined"
        />
      </Stack>
      <Errors snapshot={snapshot} />
      <InstallationDetails
        configs={configs}
        deployments={snapshot.items.filter((r) => r.plural === 'deployments')}
        bootstrap={snapshot.items.filter((r) => r.plural === 'configmaps')}
      />
      <Typography variant="subtitle2" sx={{ px: 2, pb: 1 }}>
        Manager & planning workers
      </Typography>
      <Alert severity="info" sx={{ mx: 2, mb: 1 }}>
        Shared workers create device plans. The device Pod’s planner init container prepares files; clabwire handles networking. A ready
        worker is available for requests—it does not report queue depth or an active planning job.
      </Alert>
      {pods.length ? (
        <Box sx={{ height: 320, flexShrink: 0, minHeight: 240 }}>
          <DataGrid
            {...gridProps}
            aria-label="Control plane Pods"
            rows={pods}
            columns={columns}
            sx={{ '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' } }}
          />
        </Box>
      ) : (
        <Empty title={loading ? 'Reading control plane…' : 'No control-plane Pods in this selection'}>
          Include the namespace where clabernetes is installed in Kubus’s namespace selection. Resource permissions still apply.
        </Empty>
      )}
    </Stack>
  );
}
