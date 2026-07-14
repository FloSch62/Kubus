import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import StopIcon from '@mui/icons-material/Stop';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { PortForwardInfo } from '@kubus/shared';
import { usePortForwards, useStopPortForward } from '../api/queries.js';
import { copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { StatusChip } from '../components/StatusChip.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

export function PortForwardsPage() {
  const { data, isLoading } = usePortForwards();
  const { mutate: stop } = useStopPortForward();

  const columns: GridColDef<PortForwardInfo>[] = useMemo(() => {
    const defs: GridColDef<PortForwardInfo>[] = [
      {
        field: 'local',
        headerName: 'Local',
        width: 160,
        valueGetter: (_v, row) => row.localPort,
        renderCell: (p) => (
          <Link href={`http://localhost:${p.row.localPort}`} target="_blank" rel="noreferrer">
            localhost:{p.row.localPort}
          </Link>
        ),
      },
      { field: 'target', headerName: 'Target', flex: 1, minWidth: 220, valueGetter: (_v, row) => `${row.kind}/${row.namespace}/${row.name}:${row.remotePort}` },
      { field: 'pod', headerName: 'Pod', flex: 1, minWidth: 180, valueGetter: (_v, row) => row.targetPod ?? '' },
      { field: 'ctx', headerName: 'Cluster', width: 150, valueGetter: (_v, row) => row.ctx },
      {
        field: 'state',
        headerName: 'State',
        width: 110,
        renderCell: (p) => (
          <Tooltip title={p.row.error ?? ''}>
            <span>
              <StatusChip status={p.row.state === 'active' ? 'Ready' : 'Error'} />
            </span>
          </Tooltip>
        ),
      },
      { field: 'connections', headerName: 'Conns', width: 70, type: 'number', valueGetter: (_v, row) => row.connections },
      {
        field: '_stop',
        headerName: '',
        width: 60,
        sortable: false,
        renderCell: (p) => (
          <Tooltip title="Stop forward">
            <IconButton size="small" color="error" onClick={() => stop(p.row.id)}>
              <StopIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ),
      },
    ];
    return defs.map(withCellCopy);
  }, [stop]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Port Forwards" icon={<CableOutlinedIcon />}>
        <Chip label={`${data?.length ?? 0} active`} variant="outlined" />
      </PageHeader>
      {(data?.length ?? 0) === 0 && !isLoading ? (
        <EmptyState
          icon={<CableOutlinedIcon />}
          title="No active forwards"
          subtitle="Start one from a Pod or Service row menu (⋮ → Port forward)."
        />
      ) : (
        <DataGrid
          rows={data ?? []}
          columns={columns}
          loading={isLoading}
          getRowId={(r) => r.id}
          density="compact"
          onCellKeyDown={handleCopyCellKeyDown}
          sx={{ border: 0, ...copyCellGridSx }}
        />
      )}
    </Box>
  );
}
