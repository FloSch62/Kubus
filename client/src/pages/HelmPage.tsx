import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import { useNavigate } from 'react-router';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { HelmReleaseSummary } from '@kubus/shared';
import { useHelmReleases } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

interface Row {
  ctx: string;
  release: HelmReleaseSummary;
}

export function HelmPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const { data, isLoading } = useHelmReleases(selected);
  const navigate = useNavigate();

  const rows = useMemo(() => {
    const all = data ?? [];
    if (!namespaces.length) return all;
    const set = new Set(namespaces);
    return all.filter((r) => set.has(r.release.namespace));
  }, [data, namespaces]);

  const columns: GridColDef<Row>[] = useMemo(
    () => [
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
    ],
    [selected.length],
  );

  if (selected.length === 0) {
    return (
      <EmptyState icon={<SailingOutlinedIcon />} title="No cluster selected" subtitle="Select a cluster to view Helm releases." />
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5, pt: 1.5 }}>
      <PageHeader title="Helm Releases" icon={<SailingOutlinedIcon />}>
        <Chip label={`${rows.length} releases`} variant="outlined" />
      </PageHeader>
      <DataGrid
        rows={rows}
        columns={columns}
        loading={isLoading}
        getRowId={(r) => `${r.ctx}/${r.release.namespace}/${r.release.name}`}
        density="compact"
        onRowClick={(p) => navigate(`/helm/${encodeURIComponent(p.row.ctx)}/${encodeURIComponent(p.row.release.namespace)}/${encodeURIComponent(p.row.release.name)}`)}
        sx={{ border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' } }}
        initialState={{ sorting: { sortModel: [{ field: 'name', sort: 'asc' }] } }}
      />
    </Box>
  );
}
