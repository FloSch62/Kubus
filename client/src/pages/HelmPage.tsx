import { Suspense, lazy, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import { useNavigate } from 'react-router';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { HelmReleaseSummary } from '@kubus/shared';
import { useAppInfo, useHelmOperations, useHelmReleases, useHelmUpdates } from '../api/queries.js';
import { namespaceVisible, useClustersStore } from '../state/clusters.js';
import { copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { helmOperationPhaseLabel, helmOperationReleaseKey } from '../components/HelmOperationStatus.js';
import { HelmOperationsOverview } from '../components/HelmOperationsOverview.js';
import { countLabel } from '../components/format.js';

const HelmInstallDialog = lazy(() => import('../components/HelmInstallDialog.js'));

interface Row {
  ctx: string;
  release: HelmReleaseSummary;
}

const releasesGridSx = { flex: 1, minHeight: 0, border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' }, ...copyCellGridSx };

export function HelmPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const { data, isLoading } = useHelmReleases(selected);
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const helmEngine = useAppInfo().data?.helmEngine ?? false;
  const operations = useHelmOperations();

  const rows = useMemo(() => {
    const all = data ?? [];
    if (!namespaces.length) return all;
    return all.filter((r) => namespaceVisible(r.release.namespace, namespaces));
  }, [data, namespaces]);
  const updateItems = useMemo(
    () =>
      rows.map(({ ctx: rowCtx, release }) => ({
        id: `${rowCtx}/${release.namespace}/${release.name}`,
        chart: release.chart,
        currentVersion: release.chartVersion,
        currentAppVersion: release.appVersion,
      })),
    [rows],
  );
  const updates = useHelmUpdates(updateItems);
  const updatesById = useMemo(() => new Map((updates.data ?? []).map((update) => [update.id, update])), [updates.data]);
  const availableUpdates = useMemo(() => (updates.data ?? []).filter((update) => update.available).length, [updates.data]);
  const visibleOperations = useMemo(() => {
    const contexts = new Set(selected);
    return (operations.data ?? []).filter((operation) => contexts.has(operation.ctx));
  }, [operations.data, selected]);
  const latestOperationByRelease = useMemo(() => {
    const byRelease = new Map<string, NonNullable<typeof operations.data>[number]>();
    for (const operation of visibleOperations) {
      if (!byRelease.has(helmOperationReleaseKey(operation))) byRelease.set(helmOperationReleaseKey(operation), operation);
    }
    return byRelease;
  }, [visibleOperations]);

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
      {
        field: 'operation',
        headerName: 'Operation',
        width: 160,
        sortable: false,
        valueGetter: (_value, row) => {
          const operation = latestOperationByRelease.get(`${row.ctx}/${row.release.namespace}/${row.release.name}`);
          return operation ? `${operation.status} ${operation.phase}` : '';
        },
        renderCell: (params) => {
          const operation = latestOperationByRelease.get(`${params.row.ctx}/${params.row.release.namespace}/${params.row.release.name}`);
          if (!operation) return null;
          if (operation.status === 'running') {
            return (
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <CircularProgress size={14} />
                <Typography variant="caption">{helmOperationPhaseLabel(operation.phase)}</Typography>
              </Stack>
            );
          }
          return (
            <Chip
              size="small"
              color={operation.status === 'failed' ? 'error' : 'success'}
              variant="outlined"
              label={operation.status === 'failed' ? `${operation.kind} failed` : `${operation.kind} complete`}
            />
          );
        },
      },
      { field: 'chart', headerName: 'Chart', width: 160, valueGetter: (_v, row) => `${row.release.chart}-${row.release.chartVersion}` },
      { field: 'appVersion', headerName: 'App version', width: 110, valueGetter: (_v, row) => row.release.appVersion ?? '' },
      {
        field: 'update',
        headerName: 'Update',
        width: 155,
        sortable: false,
        valueGetter: (_v, row) => updatesById.get(`${row.ctx}/${row.release.namespace}/${row.release.name}`)?.latestVersion ?? '',
        renderCell: (params) => {
          const update = updatesById.get(`${params.row.ctx}/${params.row.release.namespace}/${params.row.release.name}`);
          if (!update) return updates.isFetching ? <CircularProgress size={14} /> : null;
          if (update.available) {
            return (
              <Tooltip title={`Found in ${update.repo ?? 'a matching chart source'}${update.latestAppVersion ? ` · app ${update.latestAppVersion}` : ''}`}>
                <Chip size="small" color="primary" variant="outlined" label={`${update.latestVersion} available`} />
              </Tooltip>
            );
          }
          if (update.reason === 'up-to-date') return <Typography variant="caption" color="text.secondary">Up to date</Typography>;
          return (
            <Tooltip title="Kubus could not safely match this release to a chart source that also contains its current version.">
              <Typography variant="caption" color="text.disabled">Source unknown</Typography>
            </Tooltip>
          );
        },
      },
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
  }, [latestOperationByRelease, selected.length, updates.isFetching, updatesById]);

  const grid = useGridPrefs('helm-releases', columns);

  if (selected.length === 0) {
    return <NoClustersState icon={<SailingOutlinedIcon />} />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5, pt: 1.5 }}>
      <PageHeader title="Helm Releases" icon={<SailingOutlinedIcon />}>
        <Chip label={countLabel(rows.length, 'release')} variant="outlined" />
        {availableUpdates > 0 ? <Chip label={`${availableUpdates} update${availableUpdates === 1 ? '' : 's'} available`} color="primary" /> : null}
        <Tooltip title="Check chart repositories for updates">
          <span>
            <IconButton size="small" onClick={() => void updates.refetch()} disabled={updates.isFetching || updateItems.length === 0}>
              {updates.isFetching ? <CircularProgress size={17} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={helmEngine ? '' : 'Helm engine not built — run node helm-engine/build.mjs (requires Go)'}>
          <span>
            <Button startIcon={<AddIcon />} variant="contained" size="small" disabled={!helmEngine} onClick={() => setInstallOpen(true)}>
              Install chart
            </Button>
          </span>
        </Tooltip>
      </PageHeader>
      <HelmOperationsOverview
        operations={visibleOperations}
        error={operations.error}
        isLoading={operations.isLoading}
        isFetching={operations.isFetching}
        onRefresh={() => void operations.refetch()}
      />
      <DataGrid
        rows={rows}
        columns={grid.columns}
        loading={isLoading}
        getRowId={(r) => `${r.ctx}/${r.release.namespace}/${r.release.name}`}
        density={grid.density}
        onColumnWidthChange={grid.onColumnWidthChange}
        onRowClick={(p) => navigate(`/helm/${encodeURIComponent(p.row.ctx)}/${encodeURIComponent(p.row.release.namespace)}/${encodeURIComponent(p.row.release.name)}`)}
        onCellKeyDown={(params, event, details) => {
          handleCopyCellKeyDown(params, event, details);
          // Keyboard equivalent of clicking the row.
          if (event.key === 'Enter') {
            event.preventDefault();
            void navigate(
              `/helm/${encodeURIComponent(params.row.ctx)}/${encodeURIComponent(params.row.release.namespace)}/${encodeURIComponent(params.row.release.name)}`,
            );
          }
        }}
        sx={releasesGridSx}
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
