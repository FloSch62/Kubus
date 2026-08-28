import { Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import { useNavigate } from 'react-router';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { HelmReleaseSummary } from '@kubus/shared';
import { useAppInfo, useHelmOperations, useHelmReleases, useHelmUninstall, useHelmUpdates } from '../api/queries.js';
import { namespaceVisible, useClustersStore, useIsProtected } from '../state/clusters.js';
import { CellCopyOverlay, copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { helmOperationPhaseLabel, helmOperationReleaseKey } from '../components/HelmOperationStatus.js';
import { HelmOperationsOverview } from '../components/HelmOperationsOverview.js';
import { countLabel } from '../components/format.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { showToast } from '../state/toast.js';

const HelmInstallDialog = lazy(() => import('../components/HelmInstallDialog.js'));

interface Row {
  ctx: string;
  release: HelmReleaseSummary;
}

interface ReleaseContextMenu {
  row: Row;
  mouseX: number;
  mouseY: number;
}

const releasesGridSx = { flex: 1, minHeight: 0, border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' }, ...copyCellGridSx };

export function HelmPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const { data, isLoading } = useHelmReleases(selected);
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ReleaseContextMenu | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<Row | null>(null);
  const gridRootRef = useRef<HTMLDivElement>(null);
  const helmEngine = useAppInfo().data?.helmEngine ?? false;
  const operations = useHelmOperations();
  const uninstall = useHelmUninstall();
  const uninstallTargetProtected = useIsProtected(uninstallTarget?.ctx ?? '');

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
  const rowsById = useMemo(() => new Map(rows.map((row) => [`${row.ctx}/${row.release.namespace}/${row.release.name}`, row])), [rows]);
  const releasePath = useCallback(
    (row: Row) => `/helm/${encodeURIComponent(row.ctx)}/${encodeURIComponent(row.release.namespace)}/${encodeURIComponent(row.release.name)}`,
    [],
  );
  const openRelease = useCallback((row: Row) => void navigate(releasePath(row)), [navigate, releasePath]);
  const openContextMenu = useCallback((row: Row, clientX: number, clientY: number) => {
    setContextMenu({ row, mouseX: clientX + 2, mouseY: clientY - 6 });
  }, []);
  const rowSlotProps = useMemo(
    () => ({
      row: {
        onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
          event.preventDefault();
          event.stopPropagation();
          const id = event.currentTarget.getAttribute('data-id');
          const row = id ? rowsById.get(id) : undefined;
          if (row) openContextMenu(row, event.clientX, event.clientY);
        },
      },
    }),
    [openContextMenu, rowsById],
  );
  const uninstallTargetOperation = uninstallTarget
    ? latestOperationByRelease.get(`${uninstallTarget.ctx}/${uninstallTarget.release.namespace}/${uninstallTarget.release.name}`)
    : undefined;
  const uninstallBlockedByOperation = uninstallTargetOperation?.status === 'running';

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
    <Box ref={gridRootRef} sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5, pt: 1.5 }}>
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
        onRowClick={(p) => openRelease(p.row)}
        slotProps={rowSlotProps}
        onCellKeyDown={(params, event, details) => {
          handleCopyCellKeyDown(params, event, details);
          // Keyboard equivalent of clicking the row.
          if (event.key === 'Enter') {
            event.preventDefault();
            openRelease(params.row);
          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const cell = (event.target as HTMLElement | null)?.closest?.('.MuiDataGrid-cell');
            const rect = (cell ?? (event.target as HTMLElement)).getBoundingClientRect();
            openContextMenu(params.row, rect.left + 8, rect.bottom - 4);
          }
        }}
        sx={releasesGridSx}
        initialState={{ sorting: { sortModel: [{ field: 'name', sort: 'asc' }] } }}
      />
      <CellCopyOverlay rootRef={gridRootRef} />
      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <MenuItem
          onClick={() => {
            if (!contextMenu) return;
            openRelease(contextMenu.row);
            setContextMenu(null);
          }}
        >
          <ListItemIcon>
            <OpenInNewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Open release</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={
            !!contextMenu &&
            latestOperationByRelease.get(`${contextMenu.row.ctx}/${contextMenu.row.release.namespace}/${contextMenu.row.release.name}`)?.status === 'running'
          }
          onClick={() => {
            if (!contextMenu) return;
            setUninstallTarget(contextMenu.row);
            setContextMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <DeleteIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText>Uninstall…</ListItemText>
        </MenuItem>
      </Menu>
      <ConfirmDialog
        open={uninstallTarget !== null}
        title={`Uninstall ${uninstallTarget?.release.name ?? ''}`}
        danger
        confirmLabel="Uninstall"
        busy={uninstall.isPending}
        disabled={uninstallBlockedByOperation}
        confirmText={uninstallTargetProtected ? uninstallTarget?.release.name : undefined}
        message={
          uninstallTarget ? (
            <>
              Uninstall <b>{uninstallTarget.release.namespace}/{uninstallTarget.release.name}</b> from cluster <b>{uninstallTarget.ctx}</b>? This deletes every
              resource in the release manifest, then removes the release records only after cleanup succeeds. Stored pre-delete and post-delete hooks are executed.
              {uninstallBlockedByOperation ? (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  Cannot uninstall while the {uninstallTargetOperation.kind} operation is running.
                </Alert>
              ) : null}
            </>
          ) : null
        }
        onClose={() => setUninstallTarget(null)}
        onConfirm={() => {
          if (!uninstallTarget || uninstallBlockedByOperation) return;
          const target = uninstallTarget;
          uninstall.mutate(
            { ctx: target.ctx, ns: target.release.namespace, name: target.release.name },
            {
              onSuccess: (result) => {
                setUninstallTarget(null);
                if (result.failed.length) {
                  showToast(
                    'error',
                    `Uninstall incomplete: ${result.failed.length} item${result.failed.length === 1 ? '' : 's'} failed${
                      result.recordsRetained ? '; release history was retained for inspection and retry' : ''
                    }`,
                  );
                  return;
                }
                showToast(
                  'success',
                  `Uninstalled ${target.release.name}: ${result.deleted.length} resources deleted${
                    result.crdsDeleted.length ? `, ${result.crdsDeleted.length} CRDs` : ''
                  }`,
                );
              },
              onError: (error) => {
                setUninstallTarget(null);
                showToast('error', `Uninstall failed: ${error.message}`);
              },
            },
          );
        }}
      />
      {installOpen && (
        <Suspense fallback={null}>
          <HelmInstallDialog contexts={selected} onClose={() => setInstallOpen(false)} />
        </Suspense>
      )}
    </Box>
  );
}
