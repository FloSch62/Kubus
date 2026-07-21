import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import StopIcon from '@mui/icons-material/Stop';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { PortForwardInfo } from '@kubus/shared';
import { usePortForwards, useStopAllPortForwards, useStopPortForward } from '../api/queries.js';
import { copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { StatusChip } from '../components/StatusChip.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

const forwardsGridSx = { border: 0, ...copyCellGridSx };

export function PortForwardsPage() {
  const { data, isLoading } = usePortForwards();
  const { mutate: stop } = useStopPortForward();
  const stopAll = useStopAllPortForwards();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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
              <StatusChip status={p.row.state === 'active' ? 'Active' : 'Error'} />
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

  const grid = useGridPrefs('port-forwards', columns);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Port Forwards" icon={<CableOutlinedIcon />}>
        <Chip label={`${data?.length ?? 0} active`} variant="outlined" />
        <Box sx={{ flex: 1 }} />
        {selectedIds.length > 0 && (
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<StopIcon />}
            onClick={() => {
              for (const id of selectedIds) stop(id);
              setSelectedIds([]);
            }}
          >
            Stop selected ({selectedIds.length})
          </Button>
        )}
        {(data?.length ?? 0) > 0 && (
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<StopCircleOutlinedIcon />}
            disabled={stopAll.isPending}
            onClick={() => {
              stopAll.mutate();
              setSelectedIds([]);
            }}
          >
            Stop all
          </Button>
        )}
      </PageHeader>
      {(data?.length ?? 0) === 0 && !isLoading ? (
        <EmptyState
          icon={<CableOutlinedIcon />}
          title="No active forwards"
          subtitle="Start one from a Pod, Service or workload row menu (⋮ → Port forward…), or from the ports listed in a resource's details."
        />
      ) : (
        <DataGrid
          rows={data ?? []}
          columns={grid.columns}
          loading={isLoading}
          getRowId={(r) => r.id}
          density={grid.density}
          checkboxSelection
          disableRowSelectionOnClick
          onRowSelectionModelChange={(model) => {
            // The header "select all" checkbox reports an exclude-type model
            // whose ids are the deselected rows.
            const ids = model.ids instanceof Set ? model.ids : new Set();
            const rows = data ?? [];
            setSelectedIds(
              (model.type === 'exclude' ? rows.filter((r) => !ids.has(r.id)) : rows.filter((r) => ids.has(r.id))).map((r) => r.id),
            );
          }}
          onColumnWidthChange={grid.onColumnWidthChange}
          onCellKeyDown={handleCopyCellKeyDown}
          sx={forwardsGridSx}
        />
      )}
    </Box>
  );
}
