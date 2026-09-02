import { Suspense, lazy, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import SearchIcon from '@mui/icons-material/Search';
import SystemUpdateAltOutlinedIcon from '@mui/icons-material/SystemUpdateAltOutlined';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import { useNavigate } from 'react-router';
import type { GridColDef } from '@mui/x-data-grid';
import { DataGrid } from '@mui/x-data-grid';
import type { HelmChartUpdate, HelmOperation, HelmReleaseSummary } from '@kubus/shared';
import { useAppInfo, useHelmOperations, useHelmReleases, useHelmUninstall, useHelmUpdates } from '../api/queries.js';
import { namespaceVisible, useClustersStore, useIsProtected } from '../state/clusters.js';
import { CellCopyOverlay, copyCellGridSx, handleCopyCellKeyDown, withCellCopy } from '../components/CellCopy.js';
import { useGridPrefs } from '../components/grid-prefs.js';
import { StatusChip } from '../components/StatusChip.js';
import { AgeCell } from '../components/AgeCell.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { PageHeader } from '../components/PageHeader.js';
import { HelmLiveBadge } from '../components/HelmLiveBadge.js';
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

type ReleaseFilter = 'all' | 'attention' | 'updates';

const releasesGridSx = { flex: 1, minHeight: 0, border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' }, ...copyCellGridSx };
/** Helm statuses that mean "done and fine"; everything else deserves a look. */
const SETTLED_STATUSES = new Set(['deployed', 'superseded']);

export function rowId(row: Pick<Row, 'ctx'> & { release: Pick<HelmReleaseSummary, 'namespace' | 'name'> }): string {
  return `${row.ctx}/${row.release.namespace}/${row.release.name}`;
}

export function releasePath(row: Row): string {
  return `/helm/${encodeURIComponent(row.ctx)}/${encodeURIComponent(row.release.namespace)}/${encodeURIComponent(row.release.name)}`;
}

/** A release needs attention when its record is not settled or its latest operation failed. */
export function needsAttention(release: HelmReleaseSummary, operation: HelmOperation | undefined): boolean {
  return !SETTLED_STATUSES.has(release.status) || operation?.status === 'failed';
}

function matchesText(row: Row, words: string[]): boolean {
  if (!words.length) return true;
  const haystack = `${row.release.name} ${row.release.namespace} ${row.release.chart} ${row.release.chartVersion} ${row.release.appVersion ?? ''} ${row.ctx} ${row.release.status}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function NoReleasesOverlay({ hidden, total, helmEngine, onInstall }: { hidden: number; total: number; helmEngine: boolean; onInstall: () => void }) {
  return (
    <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
      <SailingOutlinedIcon sx={{ fontSize: 34, color: 'text.secondary', opacity: 0.55 }} />
      <Typography variant="body2" color="text.secondary">
        {hidden > 0 ? `No matches, ${countLabel(hidden, 'release')} hidden by the current filters` : total === 0 ? 'No Helm releases in the selected clusters' : 'No releases in the selected namespaces'}
      </Typography>
      {total === 0 && helmEngine ? (
        <Button size="small" startIcon={<AddIcon />} onClick={onInstall}>
          Install a chart
        </Button>
      ) : null}
    </Stack>
  );
}

export function HelmPage() {
  const selected = useClustersStore((s) => s.selected);
  const namespaces = useClustersStore((s) => s.namespaces);
  const releases = useHelmReleases(selected);
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ReleaseContextMenu | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<Row | null>(null);
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState<ReleaseFilter>('all');
  const deferredFilterText = useDeferredValue(filterText);
  const gridRootRef = useRef<HTMLDivElement>(null);
  const helmEngine = useAppInfo().data?.helmEngine ?? false;
  const operations = useHelmOperations();
  const uninstall = useHelmUninstall();
  const uninstallTargetProtected = useIsProtected(uninstallTarget?.ctx ?? '');

  const scoped = useMemo(() => {
    const all = releases.rows;
    if (!namespaces.length) return all;
    return all.filter((r) => namespaceVisible(r.release.namespace, namespaces));
  }, [releases.rows, namespaces]);
  const updateItems = useMemo(
    () =>
      scoped.map(({ ctx: rowCtx, release }) => ({
        id: `${rowCtx}/${release.namespace}/${release.name}`,
        chart: release.chart,
        currentVersion: release.chartVersion,
        currentAppVersion: release.appVersion,
      })),
    [scoped],
  );
  const updates = useHelmUpdates(updateItems);
  const updatesById = useMemo(() => new Map<string, HelmChartUpdate>((updates.data ?? []).map((update) => [update.id, update])), [updates.data]);
  const availableUpdates = useMemo(() => (updates.data ?? []).filter((update) => update.available).length, [updates.data]);
  const visibleOperations = useMemo(() => {
    const contexts = new Set(selected);
    return (operations.data ?? []).filter((operation) => contexts.has(operation.ctx));
  }, [operations.data, selected]);
  const latestOperationByRelease = useMemo(() => {
    const byRelease = new Map<string, HelmOperation>();
    for (const operation of visibleOperations) {
      if (!byRelease.has(helmOperationReleaseKey(operation))) byRelease.set(helmOperationReleaseKey(operation), operation);
    }
    return byRelease;
  }, [visibleOperations]);
  const attentionCount = useMemo(() => scoped.filter((row) => needsAttention(row.release, latestOperationByRelease.get(rowId(row)))).length, [latestOperationByRelease, scoped]);
  const rows = useMemo(() => {
    const words = deferredFilterText.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return scoped.filter((row) => {
      if (!matchesText(row, words)) return false;
      if (filter === 'attention') return needsAttention(row.release, latestOperationByRelease.get(rowId(row)));
      if (filter === 'updates') return !!updatesById.get(rowId(row))?.available;
      return true;
    });
  }, [deferredFilterText, filter, latestOperationByRelease, scoped, updatesById]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [rowId(row), row])), [rows]);
  const openRelease = useCallback((row: Row, action?: 'upgrade') => void navigate(`${releasePath(row)}${action ? `?action=${action}` : ''}`), [navigate]);
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
  const uninstallTargetOperation = uninstallTarget ? latestOperationByRelease.get(rowId(uninstallTarget)) : undefined;
  const uninstallBlockedByOperation = uninstallTargetOperation?.status === 'running';
  const contextMenuOperation = contextMenu ? latestOperationByRelease.get(rowId(contextMenu.row)) : undefined;
  const contextMenuBusy = contextMenuOperation?.status === 'running';
  const hiddenByFilters = scoped.length - rows.length;
  const failedClusters = Object.entries(releases.errors);

  const columns: GridColDef<Row>[] = useMemo(() => {
    const defs: GridColDef<Row>[] = [
      { field: 'name', headerName: 'Release', flex: 1, minWidth: 160, valueGetter: (_v, row) => row.release.name },
      { field: 'namespace', headerName: 'Namespace', width: 130, valueGetter: (_v, row) => row.release.namespace },
      ...(selected.length > 1 ? [{ field: 'cluster', headerName: 'Cluster', width: 140, valueGetter: (_v: never, row: Row) => row.ctx } as GridColDef<Row>] : []),
      {
        field: 'status',
        headerName: 'Status',
        width: 130,
        valueGetter: (_v, row) => row.release.status,
        renderCell: (p) => <StatusChip status={p.row.release.status} />,
      },
      {
        field: 'operation',
        headerName: 'Operation',
        width: 160,
        sortable: false,
        valueGetter: (_value, row) => {
          const operation = latestOperationByRelease.get(rowId(row));
          return operation ? `${operation.status} ${operation.phase}` : '';
        },
        renderCell: (params) => {
          const operation = latestOperationByRelease.get(rowId(params.row));
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
      { field: 'chart', headerName: 'Chart', width: 170, valueGetter: (_v, row) => `${row.release.chart}-${row.release.chartVersion}` },
      { field: 'appVersion', headerName: 'App version', width: 110, valueGetter: (_v, row) => row.release.appVersion ?? '' },
      {
        field: 'update',
        headerName: 'Update',
        width: 155,
        sortable: false,
        valueGetter: (_v, row) => updatesById.get(rowId(row))?.latestVersion ?? '',
        renderCell: (params) => {
          const update = updatesById.get(rowId(params.row));
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
  const openInstall = useCallback(() => setInstallOpen(true), []);
  const totalReleases = releases.rows.length;
  const NoRowsOverlay = useCallback(
    () => <NoReleasesOverlay hidden={hiddenByFilters} total={totalReleases} helmEngine={helmEngine} onInstall={openInstall} />,
    [helmEngine, hiddenByFilters, openInstall, totalReleases],
  );
  const gridSlots = useMemo(() => ({ noRowsOverlay: NoRowsOverlay }), [NoRowsOverlay]);

  if (selected.length === 0) {
    return <NoClustersState icon={<SailingOutlinedIcon />} />;
  }

  return (
    <Box ref={gridRootRef} sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5, pt: 1.5 }}>
      <PageHeader title="Helm Releases" icon={<SailingOutlinedIcon />}>
        <Chip label={countLabel(scoped.length, 'release')} variant="outlined" />
        {availableUpdates > 0 ? <Chip label={`${availableUpdates} update${availableUpdates === 1 ? '' : 's'} available`} color="primary" /> : null}
        <HelmLiveBadge contexts={selected} updatedAt={releases.dataUpdatedAt || undefined} />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh releases">
          <span>
            <IconButton size="small" aria-label="Refresh releases" onClick={releases.refetch} disabled={releases.isFetching}>
              {releases.isFetching ? <CircularProgress size={17} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Check chart repositories for updates">
          <span>
            <IconButton size="small" aria-label="Check for chart updates" onClick={() => void updates.refetch()} disabled={updates.isFetching || updateItems.length === 0}>
              {updates.isFetching ? <CircularProgress size={17} /> : <SystemUpdateAltOutlinedIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={helmEngine ? '' : 'Helm engine not built — run node helm-engine/build.mjs (requires Go)'}>
          <span>
            <Button startIcon={<AddIcon />} variant="contained" size="small" disabled={!helmEngine} onClick={openInstall}>
              Install chart
            </Button>
          </span>
        </Tooltip>
      </PageHeader>
      {failedClusters.length > 0 ? (
        <Alert
          severity="warning"
          sx={{ mb: 1.25 }}
          action={
            <Button color="inherit" size="small" onClick={releases.refetch}>
              Retry
            </Button>
          }
        >
          {failedClusters.map(([ctx, error]) => (
            <Typography key={ctx} variant="body2">
              Releases could not be loaded from <b>{ctx}</b>: {error.message}
            </Typography>
          ))}
        </Alert>
      ) : null}
      <HelmOperationsOverview
        operations={visibleOperations}
        error={operations.error}
        isLoading={operations.isLoading}
        isFetching={operations.isFetching}
        onRefresh={() => void operations.refetch()}
      />
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          placeholder="Filter releases by name, namespace, chart or cluster"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ flex: 1, minWidth: 220, maxWidth: 420 }}
        />
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_event, value: ReleaseFilter | null) => setFilter(value ?? 'all')} aria-label="Release filter">
          <ToggleButton value="all">All · {scoped.length}</ToggleButton>
          <ToggleButton value="attention" sx={attentionCount ? { color: 'warning.main' } : undefined}>
            Needs attention · {attentionCount}
          </ToggleButton>
          <ToggleButton value="updates">Updates · {availableUpdates}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <DataGrid
        rows={rows}
        columns={grid.columns}
        loading={releases.isLoading}
        getRowId={rowId}
        density={grid.density}
        onColumnWidthChange={grid.onColumnWidthChange}
        onRowClick={(p) => openRelease(p.row)}
        slots={gridSlots}
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
        <MenuItem
          disabled={!helmEngine || contextMenuBusy}
          onClick={() => {
            if (!contextMenu) return;
            openRelease(contextMenu.row, 'upgrade');
            setContextMenu(null);
          }}
        >
          <ListItemIcon>
            <UpgradeIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Upgrade…</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={contextMenuBusy}
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
