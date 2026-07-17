import { Suspense, lazy, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import { useNavigate } from 'react-router';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { HelmReleaseSummary } from '@kubus/shared';
import { useAppInfo, useHelmReleases } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';

const HelmInstallDialog = lazy(() => import('../components/HelmInstallDialog.js'));

interface Row {
  ctx: string;
  release: HelmReleaseSummary;
}

export function HelmPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const { data, isLoading } = useHelmReleases(selected);
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const helmEngine = useAppInfo().data?.helmEngine ?? false;

  const rows = useMemo(() => {
    const all = data ?? [];
    if (!namespaces.length) return all;
    const set = new Set(namespaces);
    return all.filter((r) => set.has(r.release.namespace));
  }, [data, namespaces]);

  const columns: GridColDef<Row>[] = useMemo(() => {
    const defs: GridColDef<Row>[] = [
      { field: 'name', headerName: 'Release', flex: 1, minWidth: 160, valueGetter: (_v, row) => row.release.name },
      { field: 'namespace', headerName: 'Namespace', width: 130, valueGetter: (_v, row) => row.release.namespace },
      ...(selected.length > 1 ? [{ field: 'cluster', headerName: 'Cluster', width: 140, valueGetter: (_v: never, row: Row) => row.ctx } as GridColDef<Row>] : []),
      {
        field: 'status',
        headerName: 'Status',
        width: 120,
        valueGetter: (_v, row) => row.release.status,
        renderCell: (p) => <StatusChip status={p.row.release.status} />,
      },
      { field: 'chart', headerName: 'Chart', width: 160, valueGetter: (_v, row) => `${row.release.chart}-${row.release.chartVersion}` },
      { field: 'appVersion', headerName: 'App version', width: 110, valueGetter: (_v, row) => row.release.appVersion ?? '' },
      { field: 'revision', headerName: 'Revision', width: 80, type: 'number', valueGetter: (_v, row) => row.release.revision },
      {
        field: 'updated',
        headerName: 'Updated',
        width: 100,
        valueGetter: (_v, row) => row.release.updated ?? '',
        renderCell: (p) => <AgeCell timestamp={p.row.release.updated} />,
      },
    ];
    return defs.map(withCellCopy);
  }, [selected.length]);

  const grid = useGridPrefs('helm-releases', columns);

  if (selected.length === 0) {
    return <NoClustersState icon={<SailingOutlinedIcon />} />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5, pt: 1.5 }}>
      <PageHeader title="Helm Releases" icon={<SailingOutlinedIcon />}>
        <Chip label={`${rows.length} releases`} variant="outlined" />
        <Box sx={{ flex: 1 }} />
        <Tooltip title={helmEngine ? '' : 'Helm engine not built — run node helm-engine/build.mjs (requires Go)'}>
          <span>
            <Button startIcon={<AddIcon />} variant="contained" size="small" disabled={!helmEngine} onClick={() => setInstallOpen(true)}>
              Install chart
            </Button>
          </span>
        </Tooltip>
      </PageHeader>
      <DataGrid
        rows={rows}
        columns={grid.columns}
        loading={isLoading}
        getRowId={(r) => `${r.ctx}/${r.release.namespace}/${r.release.name}`}
        density={grid.density}
        onColumnWidthChange={grid.onColumnWidthChange}
        onRowClick={(p) => navigate(`/helm/${encodeURIComponent(p.row.ctx)}/${encodeURIComponent(p.row.release.namespace)}/${encodeURIComponent(p.row.release.name)}`)}
        onCellKeyDown={handleCopyCellKeyDown}
        sx={{ border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' }, ...copyCellGridSx }}
        initialState={{ sorting: { sortModel: [{ field: 'name', sort: 'asc' }] } }}
      />
      {installOpen && (
        <Suspense fallback={null}>
          <HelmInstallDialog contexts={selected} onClose={() => setInstallOpen(false)} />
        </Suspense>
      )}
    </Box>
  );
}
