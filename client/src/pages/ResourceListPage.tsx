import { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layout } from '../theme.js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SubjectIcon from '@mui/icons-material/Subject';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import { useParams, useSearchParams } from 'react-router';
import { columnsForKind, groupFromPath, groupToPath, gvkForResource, gvkLabel, pluralLabel, type ResourceKindInfo } from '@kubus/shared';
import { useApiResourcesForContexts, useCrdColumns, useCreateResource, useDeleteResource, useDryRunResource, useFilteredList, useResourceMetrics, useRolloutRestart, useWatchedList, type ClusterRow } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { useDockStore, dockTabId } from '../state/dock.js';
import { ResourceTable } from '../components/ResourceTable.js';
import { ApiResourceDrawer } from '../components/ApiResourceDrawer.js';
import { buildColumns, buildCrdColumns, crdHiddenFields, makeMetricsLookup, makeNodeAllocationLookup, makeWorkloadMetricsLookup, METRIC_COLUMN_IDS, WORKLOAD_METRIC_KINDS } from '../components/columns.js';
import { ResourceDetailPanel, type ResourceSelection } from '../components/ResourceDetailDrawer.js';
import { clampDetailWidth, DEFAULT_DETAIL_WIDTH, useDetailStore } from '../state/detail.js';
import { isLogTargetKind, RowActionMenu, RowActions, RowLogsButton, type RowActionTarget } from '../components/RowActions.js';
import { YamlEditor } from '../components/YamlEditor.js';
import { BatchCreateDialog } from '../components/BatchCreateDialog.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { showToast } from '../state/toast.js';
import { useNavigationStore } from '../state/navigation.js';
import { usePaneActive } from '../layout/pane-context.js';
import { isTextEntryTarget } from '../text-entry.js';
import { addLabelTerm } from '../label-selector.js';
import { podContainerNames } from '../kube-display.js';

// Wide, rarely-needed builtin columns start hidden; the column menu re-enables
// them. Labels carry no signal on CRDs, so the Kind/Group/Scope columns take
// their place there.
const BUILTIN_HIDDEN_FIELDS: Record<string, string[]> = { Node: ['nodeProviderID'], CustomResourceDefinition: ['labels'] };

/**
 * Renderless bridge between this page's URL params and the shared detail
 * selection. Pages stay mounted (and live) in hidden tab panes, so everything
 * here gates on pane activity: only the visible pane may drive the detail view or
 * rewrite the URL. Kept out of ResourceListPage so activation flips re-render
 * this stub instead of the whole page.
 */
function DetailUrlSync({ sel }: { sel: ResourceSelection | undefined }) {
  const paneActive = usePaneActive();
  const [searchParams, setSearchParams] = useSearchParams();
  const openDetail = useDetailStore((s) => s.open);
  const closeDetail = useDetailStore((s) => s.close);

  // Drop the legacy `field` param from deep links.
  useEffect(() => {
    if (!paneActive || !searchParams.has('field')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('field');
    setSearchParams(next, { replace: true });
  }, [paneActive, searchParams, setSearchParams]);

  // Mirror the URL selection into the detail view. On activation this re-runs
  // and enforces this tab's selection (open its ?sel, or close a leftover).
  useEffect(() => {
    if (!paneActive) return;
    if (sel) openDetail(sel, { embedded: true });
    else closeDetail();
  }, [paneActive, sel, openDetail, closeDetail]);

  // Close the detail view when the visible page unmounts (in-tab navigation or
  // closing the active tab); a hidden tab being closed leaves it alone.
  const paneActiveRef = useRef(paneActive);
  paneActiveRef.current = paneActive;
  useEffect(
    () => () => {
      if (paneActiveRef.current) closeDetail();
    },
    [closeDetail],
  );
  return null;
}

/**
 * Renderless `c` shortcut: create a resource on the visible list page. Kept
 * out of ResourceListPage so pane-activation flips re-render this stub only.
 */
function CreateShortcut({ onCreate }: { onCreate: () => void }) {
  const paneActive = usePaneActive();
  useEffect(() => {
    if (!paneActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 'c' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
      onCreate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneActive, onCreate]);
  return null;
}

/**
 * Side-by-side detail view. Unlike the global overlay drawer it never blocks
 * the table (other rows stay clickable) and only closes explicitly — but it
 * also only takes space while a resource is selected. The divider drags to
 * resize, and a small pill handle on it collapses the panel without dropping
 * the selection.
 */
function EmbeddedResourceDetail() {
  // Keep the detail stack mounted so editor state survives tab switches, but
  // pause its effects and hidden rendering work with an Activity boundary.
  const paneActive = usePaneActive();
  const stack = useDetailStore((s) => s.stack);
  const back = useDetailStore((s) => s.back);
  const close = useDetailStore((s) => s.close);
  const collapsed = useDetailStore((s) => s.collapsed);
  const setCollapsed = useDetailStore((s) => s.setCollapsed);
  const width = useDetailStore((s) => s.width);
  const setWidth = useDetailStore((s) => s.setWidth);
  const focusSeq = useDetailStore((s) => s.focusSeq);
  const [searchParams, setSearchParams] = useSearchParams();
  const asideRef = useRef<HTMLElement>(null);

  // Keyboard row activation asks for focus here; Escape hands it back.
  useEffect(() => {
    if (focusSeq && paneActive) asideRef.current?.focus({ preventScroll: true });
  }, [focusSeq, paneActive]);

  // Drag writes the width straight to the DOM; once the mouseup commit
  // re-renders with the same value, drop the inline override so sx takes
  // over again (otherwise collapse and double-click reset can't shrink it).
  useLayoutEffect(() => {
    if (asideRef.current) asideRef.current.style.width = '';
  }, [width, collapsed]);

  const sel = stack.at(-1);
  if (!sel) return null;

  const handleClose = () => {
    close();
    if (!searchParams.has('sel')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('sel');
    setSearchParams(next, { replace: true });
  };

  // Same drag pattern as BottomDock: width goes straight to the DOM (one
  // write per frame) and the store is committed once on mouseup.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = asideRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startWidth = useDetailStore.getState().width;
    let pending = startWidth;
    let frame = 0;
    el.style.transition = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      pending = clampDetailWidth(startWidth + (startX - ev.clientX));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          el.style.width = `${pending}px`;
        });
      }
    };
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      el.style.width = `${pending}px`;
      el.style.transition = '';
      document.body.style.cursor = '';
      setWidth(pending);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <Activity mode={paneActive ? 'visible' : 'hidden'}>
      <Box
        component="aside"
        ref={asideRef}
        aria-label="Resource details"
        tabIndex={-1}
        onKeyDown={(e) => {
          // Escape closes the panel and hands focus back to the grid — but
          // never while typing (inputs, Monaco), where Escape has meaning.
          if (e.key !== 'Escape' || isTextEntryTarget(e.target)) return;
          e.stopPropagation();
          const page = asideRef.current?.closest('.kubus-resource-page');
          handleClose();
          // Query after the close re-renders — the grid re-lays-out without
          // the panel and may recreate cell nodes. Prefer the cell the grid
          // last had focused, fall back to the first cell.
          requestAnimationFrame(() => {
            const cell =
              page?.querySelector<HTMLElement>('.MuiDataGrid-cell[tabindex="0"], .MuiDataGrid-columnHeader[tabindex="0"]') ??
              page?.querySelector<HTMLElement>('.MuiDataGrid-cell');
            cell?.focus();
          });
        }}
        sx={{
          position: 'relative',
          flexShrink: 0,
          minHeight: 0,
          width: collapsed ? 0 : width,
          maxWidth: '70%',
          transition: 'width 150ms ease',
          bgcolor: 'background.paper',
          borderLeft: 1,
          borderColor: 'divider',
          outline: 'none',
        }}
      >
        {!collapsed && (
          <Box
            onMouseDown={startResize}
            onDoubleClick={() => setWidth(DEFAULT_DETAIL_WIDTH)}
            // z 71/72 on the handles: the grid's floating scrollbars sit at
            // z 60 (70 on hover) in the same stacking context and would
            // otherwise swallow clicks on the halves that overhang the table.
            sx={{
              position: 'absolute',
              left: -4,
              top: 0,
              bottom: 0,
              width: 8,
              cursor: 'col-resize',
              zIndex: layout.zDetailResizeHandle,
              '&:hover .drag-line, &:active .drag-line': { opacity: 1 },
            }}
          >
            <Box
              className="drag-line"
              sx={{
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 3,
                height: '100%',
                bgcolor: 'primary.main',
                opacity: 0,
                transition: 'opacity 120ms ease',
              }}
            />
          </Box>
        )}
        <Tooltip title={collapsed ? 'Expand details' : 'Collapse details'} placement="left">
          <ButtonBase
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand resource details' : 'Collapse resource details'}
            aria-expanded={!collapsed}
            sx={{
              position: 'absolute',
              top: '50%',
              left: collapsed ? 'auto' : 0,
              right: collapsed ? 0 : 'auto',
              transform: collapsed ? 'translateY(-50%)' : 'translate(-50%, -50%)',
              zIndex: layout.zDetailCollapseButton,
              width: 20,
              height: 52,
              borderRadius: '10px',
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: 2,
              color: 'text.secondary',
              '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
            }}
          >
            {collapsed ? <ChevronLeftIcon sx={{ fontSize: 16 }} /> : <ChevronRightIcon sx={{ fontSize: 16 }} />}
          </ButtonBase>
        </Tooltip>
        {/* Kept mounted through a collapse so tab/editor state survives; inert
            drops it from tab order while it is hidden. */}
        <Box inert={collapsed} sx={{ height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ResourceDetailPanel sel={sel} onClose={handleClose} onBack={stack.length > 1 ? back : undefined} />
        </Box>
      </Box>
    </Activity>
  );
}

export function ResourceListPage() {
  const params = useParams<{ group: string; version: string; plural: string }>();
  const group = groupFromPath(params.group ?? 'core');
  const version = params.version ?? 'v1';
  const plural = params.plural ?? 'pods';

  const selected = useClustersStore((s) => s.selected);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const kindInfo: ResourceKindInfo | undefined = useMemo(
    () => apiResources?.resources.find((r) => r.group === group && r.version === version && r.plural === plural),
    [apiResources, group, version, plural],
  );
  const builtinKind = useMemo(() => gvkForResource(group, version, plural), [group, version, plural]);
  const kind = kindInfo?.kind ?? builtinKind?.kind ?? plural;
  const behaviorKind = builtinKind?.kind === kind ? kind : undefined;
  const resourceTitle = pluralLabel(kind);
  const resourceGvk = gvkLabel({ group, version, kind });
  const namespaced = kindInfo?.namespaced ?? true;
  const isCustomKind = !!kindInfo?.custom;
  const resourceInfo = useMemo<ResourceKindInfo>(
    () => kindInfo ?? { group, version, plural, kind, namespaced: builtinKind?.namespaced ?? true, verbs: [] },
    [kindInfo, group, version, plural, kind, builtinKind],
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const textFilter = searchParams.get('q') ?? '';
  const labelSelector = searchParams.get('label') ?? '';

  const list = useFilteredList(group, version, plural, namespaced, { labelSelector });
  const isWorkloadMetricsKind = !!behaviorKind && WORKLOAD_METRIC_KINDS.has(behaviorKind);
  const wantsMetrics = behaviorKind === 'Pod' || behaviorKind === 'Node' || isWorkloadMetricsKind;
  const { data: podMetrics } = useResourceMetrics(wantsMetrics ? selected : [], behaviorKind === 'Node' ? 'nodes' : 'pods');
  const metricsUnavailable = wantsMetrics ? selected.filter((ctx) => podMetrics?.get(ctx)?.available === false) : [];
  // Node lists watch all pods for allocation totals; workload lists watch them
  // to attribute per-pod usage to the owning workload.
  const auxPods = useWatchedList(behaviorKind === 'Node' || isWorkloadMetricsKind ? selected : [], '', 'v1', 'pods');
  const nodeAllocation = useMemo(() => (behaviorKind === 'Node' ? makeNodeAllocationLookup(auxPods.rows) : undefined), [behaviorKind, auxPods.rows]);

  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = useCallback(() => setCreateOpen(true), []);
  // Batch kinds get the guided form-based create dialog instead of the raw YAML stub.
  const isBatchCreate = group === 'batch' && (kind === 'Job' || kind === 'CronJob');
  const nsFilter = useClustersStore((s) => s.namespaces);
  const [apiResourceOpen, setApiResourceOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<ClusterRow[]>([]);
  const [contextAction, setContextAction] = useState<{ target: RowActionTarget; mouseX: number; mouseY: number } | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const addTab = useDockStore((s) => s.addTab);
  const create = useCreateResource();
  const dryRun = useDryRunResource();
  const addSavedView = useNavigationStore((s) => s.addSavedView);
  const del = useDeleteResource();
  const rolloutRestart = useRolloutRestart();
  const [bulkDialog, setBulkDialog] = useState<'delete' | 'restart' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const protectByDefault = useUiPrefsStore((s) => s.protectByDefault);
  // This page instance is reused across kinds — a selection must not survive
  // the switch to a different resource list.
  useEffect(() => setSelectedRows([]), [group, version, plural]);

  const bulkRestartable = kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet';
  const bulkProtected = selectedRows.some((r) => contextSettings[r.ctx]?.protected ?? protectByDefault);
  const runBulk = async (verb: string, run: (row: ClusterRow) => Promise<unknown>) => {
    const rows = selectedRows;
    setBulkBusy(true);
    const results = await Promise.allSettled(rows.map((row) => run(row)));
    setBulkBusy(false);
    setBulkDialog(null);
    const failures = results
      .map((result, i) => ({ result, row: rows[i]! }))
      .filter((f): f is { result: PromiseRejectedResult; row: ClusterRow } => f.result.status === 'rejected');
    if (!failures.length) {
      showToast('success', `${verb} ${rows.length} ${rows.length === 1 ? kind : resourceTitle}`);
    } else {
      const first = failures[0]!;
      const message = first.result.reason instanceof Error ? first.result.reason.message : String(first.result.reason);
      showToast('error', `${verb} failed for ${failures.length} of ${rows.length} — ${first.row.obj.metadata.name}: ${message}`);
    }
  };

  // Detail selection deep-linked via ?sel=ctx|namespace|name
  const sel: ResourceSelection | undefined = useMemo(() => {
    const raw = searchParams.get('sel');
    if (!raw) return undefined;
    const [ctx, namespace, name] = raw.split('|');
    if (!ctx || !name) return undefined;
    return { ctx, group, version, plural, kind, name, namespace: namespace || undefined, custom: isCustomKind };
  }, [searchParams, group, version, plural, kind, isCustomKind]);

  // `replace` keeps filter typing from flooding the history stack.
  const setQueryParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set(key, value);
    else next.delete(key);
    next.delete('field');
    next.delete('sel');
    setSearchParams(next, { replace: true });
  };

  const addLabelFilter = useCallback(
    (term: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const updated = addLabelTerm(next.get('label') ?? '', term);
          if (updated) next.set('label', updated);
          else next.delete('label');
          next.delete('field');
          next.delete('sel');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Schema and CRD printer columns come from the first selected cluster that
  // serves this GVR — multi-cluster definition drift is not reconciled.
  const resourceCtx = useMemo(
    () => selected.find((c) => (apiResources?.byContext[c] ?? []).some((r) => r.group === group && r.version === version && r.plural === plural)),
    [selected, apiResources, group, version, plural],
  );
  const { data: printerCols } = useCrdColumns(resourceCtx, group, version, plural, isCustomKind);

  // CRD-backed kinds additionally expose their defining CRD from the generic
  // API Resource view.
  const pushDetail = useDetailStore((s) => s.push);
  const openDetail = useDetailStore((s) => s.open);
  const setDetailCollapsed = useDetailStore((s) => s.setCollapsed);
  const requestDetailFocus = useDetailStore((s) => s.requestFocus);
  const crdSelection: ResourceSelection | undefined =
    isCustomKind && resourceCtx && group
      ? {
          ctx: resourceCtx,
          group: 'apiextensions.k8s.io',
          version: 'v1',
          plural: 'customresourcedefinitions',
          kind: 'CustomResourceDefinition',
          name: `${plural}.${group}`,
        }
      : undefined;

  const rowActionTarget = useCallback(
    (row: ClusterRow): RowActionTarget => ({ ctx: row.ctx, group, version, plural, kind, obj: row.obj }),
    [group, version, plural, kind],
  );

  const metricsLookup = useMemo(
    () =>
      isWorkloadMetricsKind
        ? makeWorkloadMetricsLookup(behaviorKind ?? '', auxPods.rows, podMetrics)
        : makeMetricsLookup(behaviorKind ?? 'Resource', podMetrics),
    [isWorkloadMetricsKind, behaviorKind, auxPods.rows, podMetrics],
  );

  const columnIds = useMemo(() => columnsForKind(behaviorKind ?? 'Resource', namespaced), [behaviorKind, namespaced]);

  // Static columns are built without the metrics/allocation lookups so the
  // 20 s metrics poll (or, on Node lists, any pod churn) doesn't hand the
  // grid a full set of fresh defs — that re-renders every visible cell.
  const staticColumns = useMemo(() => {
    const ids = columnIds.filter((id) => !METRIC_COLUMN_IDS.has(id));
    const opts = { multiCluster: selected.length > 1, onLabelClick: addLabelFilter };
    const cols = buildColumns(ids, opts);
    if (isCustomKind && printerCols?.length) {
      const crdIdx = cols.findIndex((c) => c.field === 'age');
      cols.splice(crdIdx === -1 ? cols.length : crdIdx, 0, ...buildCrdColumns(printerCols));
    }
    // Labels for every kind, right before Age.
    const ageIdx = cols.findIndex((c) => c.field === 'age');
    cols.splice(ageIdx === -1 ? cols.length : ageIdx, 0, ...buildColumns(['labels'], opts));
    const quickLogs = !!behaviorKind && isLogTargetKind(behaviorKind);
    cols.push({
      field: '_actions',
      headerName: '',
      width: quickLogs ? 84 : 50,
      sortable: false,
      filterable: false,
      renderCell: (p) => (
        <>
          {quickLogs && <RowLogsButton target={rowActionTarget(p.row)} />}
          <RowActions target={rowActionTarget(p.row)} />
        </>
      ),
    });
    return cols;
  }, [columnIds, selected.length, addLabelFilter, isCustomKind, printerCols, rowActionTarget, behaviorKind]);

  const metricColumns = useMemo(() => {
    const ids = columnIds.filter((id) => METRIC_COLUMN_IDS.has(id));
    if (!ids.length) return [];
    return buildColumns(ids, { multiCluster: false, metrics: metricsLookup, nodeAllocation });
  }, [columnIds, metricsLookup, nodeAllocation]);

  const columns = useMemo(() => {
    if (!metricColumns.length) return staticColumns;
    const merged = [...staticColumns];
    for (const col of metricColumns) {
      // Insert before the first following non-metric column present in the
      // merged list, falling back to just before the actions column.
      const at = columnIds.indexOf(col.field);
      let insertAt = merged.length - 1;
      for (let i = at + 1; i < columnIds.length; i++) {
        const id = columnIds[i]!;
        if (METRIC_COLUMN_IDS.has(id)) continue;
        const idx = merged.findIndex((c) => c.field === id);
        if (idx !== -1) {
          insertAt = idx;
          break;
        }
      }
      merged.splice(insertAt, 0, col);
    }
    return merged;
  }, [staticColumns, metricColumns, columnIds]);
  const hiddenFields = useMemo(
    () => (isCustomKind && printerCols?.length ? crdHiddenFields(printerCols) : (BUILTIN_HIDDEN_FIELDS[behaviorKind ?? ''] ?? [])),
    [isCustomKind, printerCols, behaviorKind],
  );

  const discoveryMissing = useMemo(() => {
    if (!apiResources) return [];
    return selected.filter((ctx) => {
      if (apiResources.errors[ctx]) return false;
      return !(apiResources.byContext[ctx] ?? []).some((r) => r.group === group && r.version === version && r.plural === plural);
    });
  }, [apiResources, selected, group, version, plural]);
  const unavailable = Object.entries(list.status).filter(([, s]) => s.state === 'unavailable');
  const unavailableContexts = new Set(unavailable.map(([ctx]) => ctx));
  const discoveryOnlyMissing = discoveryMissing.filter((ctx) => !unavailableContexts.has(ctx));
  const errors = Object.entries(list.status).filter(([, s]) => s.state === 'error');
  const reconnecting = Object.entries(list.status).filter(([, s]) => s.state === 'reconnecting');
  const activeRowId = useMemo(() => {
    if (!sel) return undefined;
    return list.rows.find(
      (row) => row.ctx === sel.ctx && row.obj.metadata.name === sel.name && row.obj.metadata.namespace === sel.namespace,
    )?.obj.metadata.uid;
  }, [list.rows, sel]);

  if (selected.length === 0) {
    return <NoClustersState />;
  }

  const multiLogs = kind === 'Pod' && selectedRows.length > 0;
  const kindPath = `/r/${groupToPath(group)}/${version}/${plural}`;

  const openRow = (row: ClusterRow) => {
    // Update immediately so the embedded panel responds in the same render
    // cycle; the URL remains the deep-link source of truth. Picking a row is
    // an explicit ask for details, so also undo a collapse.
    openDetail(
      { ctx: row.ctx, group, version, plural, kind, name: row.obj.metadata.name, namespace: row.obj.metadata.namespace, custom: isCustomKind },
      { embedded: true },
    );
    setDetailCollapsed(false);
    const next = new URLSearchParams(searchParams);
    next.delete('field');
    next.set('sel', `${row.ctx}|${row.obj.metadata.namespace ?? ''}|${row.obj.metadata.name}`);
    setSearchParams(next);
  };

  const saveCurrentView = () => {
    const params = new URLSearchParams();
    if (textFilter.trim()) params.set('q', textFilter.trim());
    if (labelSelector.trim()) params.set('label', labelSelector.trim());
    const path = `${kindPath}${params.toString() ? `?${params.toString()}` : ''}`;
    // Snapshot the grid so restoring brings back the exact table, not just
    // the query. tableId for this grid is kindPath.
    const prefs = useUiPrefsStore.getState();
    addSavedView({
      id: `view:${path}`,
      title: `${resourceTitle}${textFilter || labelSelector ? ' view' : ''}`,
      path,
      textFilter: textFilter.trim() || undefined,
      labelSelector: labelSelector.trim() || undefined,
      grid: {
        namespaces: [...useClustersStore.getState().namespaces],
        sort: prefs.sortModels[kindPath],
        columnVisibility: prefs.columnVisibility[kindPath],
        columnWidths: prefs.columnWidths[kindPath],
      },
    });
  };

  return (
    <Box className="kubus-resource-page" sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <DetailUrlSync sel={sel} />
      <CreateShortcut onCreate={openCreate} />
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <Box sx={{ px: 1.5, pt: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Link
            component="button"
            variant="h6"
            underline="hover"
            color="primary"
            title={`Open API resource ${resourceGvk}`}
            onClick={() => setApiResourceOpen(true)}
          >
            {resourceTitle}
          </Link>
          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            {resourceGvk}
          </Typography>
        </Box>
        {errors.map(([ctx, s]) => (
          <Alert key={ctx} severity="error" sx={{ mt: 0.5 }}>
            {ctx}: {s.message ?? 'watch error'}
          </Alert>
        ))}
        {reconnecting.map(([ctx]) => (
          <Alert key={ctx} severity="warning" sx={{ mt: 0.5 }}>
            {ctx}: connection lost — reconnecting, the list may be stale.
          </Alert>
        ))}
        {unavailable.map(([ctx, s]) => (
          <Alert key={ctx} severity="info" sx={{ mt: 0.5 }}>
            {ctx}: {s.message ?? `${kind} is not installed on this cluster.`}
          </Alert>
        ))}
        {discoveryOnlyMissing.length > 0 && (
          <Alert severity="info" sx={{ mt: 0.5 }}>
            {kind} is not installed in {discoveryOnlyMissing.join(', ')}.
          </Alert>
        )}
        {metricsUnavailable.length > 0 && (
          <Alert severity="info" sx={{ mt: 0.5 }}>
            CPU/Memory unavailable — metrics-server is not reachable in {metricsUnavailable.join(', ')}.
          </Alert>
        )}
      </Box>
      <ResourceTable
        tableId={kindPath}
        rows={list.rows}
        columns={columns}
        loading={Object.values(list.status).some((s) => s.state === 'loading')}
        kind={behaviorKind ?? 'Resource'}
        metricsLookup={metricsLookup}
        filter={textFilter}
        labelSelector={labelSelector}
        onFilterChange={(value) => setQueryParam('q', value)}
        onLabelSelectorChange={(value) => setQueryParam('label', value)}
        onRowClick={openRow}
        onRowActivate={(row) => {
          // Keyboard activation also moves focus into the panel; Escape there
          // returns it to the grid.
          openRow(row);
          requestDetailFocus();
        }}
        onRowContextMenu={(row, position) => {
          setContextAction({ target: rowActionTarget(row), mouseX: position.clientX + 2, mouseY: position.clientY - 6 });
          setContextMenuOpen(true);
        }}
        checkboxSelection
        onSelectionChange={setSelectedRows}
        hiddenFields={hiddenFields}
        activeRowId={activeRowId}
        toolbar={
          <>
            <Button startIcon={<BookmarkAddOutlinedIcon />} variant="outlined" onClick={saveCurrentView}>
              Save view
            </Button>
            {multiLogs && (
              <Button
                startIcon={<SubjectIcon />}
                variant="outlined"
                onClick={() => {
                  // Group by ctx+namespace — one log session per group.
                  const groups = new Map<string, ClusterRow[]>();
                  for (const row of selectedRows) {
                    const key = `${row.ctx}|${row.obj.metadata.namespace ?? ''}`;
                    groups.set(key, [...(groups.get(key) ?? []), row]);
                  }
                  for (const [key, rows] of groups) {
                    const [ctx, namespace] = key.split('|');
                    addTab({
                      kind: 'logs',
                      id: dockTabId(),
                      title: `logs: ${rows.length} pods`,
                      ctx: ctx!,
                      namespace: namespace ?? '',
                      pods: rows.map((r) => r.obj.metadata.name),
                      sources: rows.map((r) => ({ pod: r.obj.metadata.name, containers: podContainerNames(r.obj) })),
                      follow: true,
                      tailLines: 500,
                    });
                  }
                }}
              >
                Logs ({selectedRows.length})
              </Button>
            )}
            {selectedRows.length > 0 && bulkRestartable && (
              <Button startIcon={<RestartAltIcon />} variant="outlined" onClick={() => setBulkDialog('restart')}>
                Restart ({selectedRows.length})
              </Button>
            )}
            {selectedRows.length > 0 && (
              <Button startIcon={<DeleteOutlineIcon />} color="error" variant="outlined" onClick={() => setBulkDialog('delete')}>
                Delete ({selectedRows.length})
              </Button>
            )}
            <Button startIcon={<AddIcon />} variant="outlined" onClick={() => setCreateOpen(true)}>
              Create
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={bulkDialog === 'delete'}
        title={`Delete ${selectedRows.length} ${selectedRows.length === 1 ? kind : resourceTitle}`}
        message={
          <>
            Delete the selected {selectedRows.length === 1 ? kind : `${selectedRows.length} ${resourceTitle}`}? This cannot be undone.
            <BulkTargetList rows={selectedRows} />
          </>
        }
        confirmLabel="Delete"
        danger
        busy={bulkBusy}
        confirmText={bulkProtected ? `delete ${selectedRows.length}` : undefined}
        onClose={() => setBulkDialog(null)}
        onConfirm={() =>
          void runBulk('Deleted', (row) =>
            del.mutateAsync({ ctx: row.ctx, group, version, plural, name: row.obj.metadata.name, namespace: row.obj.metadata.namespace }),
          )
        }
      />
      <ConfirmDialog
        open={bulkDialog === 'restart'}
        title={`Restart ${selectedRows.length} ${selectedRows.length === 1 ? kind : resourceTitle}`}
        message={
          <>
            Trigger a rolling restart of the selected {selectedRows.length === 1 ? kind : `${selectedRows.length} ${resourceTitle}`}?
            <BulkTargetList rows={selectedRows} />
          </>
        }
        confirmLabel="Restart"
        busy={bulkBusy}
        confirmText={bulkProtected ? `restart ${selectedRows.length}` : undefined}
        onClose={() => setBulkDialog(null)}
        onConfirm={() =>
          void runBulk('Restarted', (row) =>
            rolloutRestart.mutateAsync({
              ctx: row.ctx,
              body: { kind: kind as 'Deployment', namespace: row.obj.metadata.namespace ?? '', name: row.obj.metadata.name },
            }),
          )
        }
      />
      {contextAction && (
        <RowActionMenu
          key={contextAction.target.obj.metadata.uid}
          target={contextAction.target}
          anchorPosition={{ top: contextAction.mouseY, left: contextAction.mouseX }}
          open={contextMenuOpen}
          onClose={() => setContextMenuOpen(false)}
        />
      )}
      <ApiResourceDrawer
        open={apiResourceOpen}
        ctx={resourceCtx}
        resource={resourceInfo}
        onClose={() => setApiResourceOpen(false)}
        onOpenCrd={
          crdSelection
            ? () => {
                setApiResourceOpen(false);
                pushDetail(crdSelection, { embedded: true });
              }
            : undefined
        }
      />
      {createOpen && isBatchCreate && selected[0] ? (
        <BatchCreateDialog
          ctx={selected[0]}
          kind={kind as 'Job' | 'CronJob'}
          group={group}
          version={version}
          defaultNamespace={nsFilter.length === 1 ? nsFilter[0] : undefined}
          onClose={() => setCreateOpen(false)}
        />
      ) : (
        <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: '80vh' } } }}>
          <DialogTitle>Create resource{selected.length > 1 ? ` on ${selected[0]}` : ''}</DialogTitle>
          <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
            <YamlEditor
              value={createTemplate(kind, group, version)}
              applyLabel="Create"
              applyUnchanged
              schema={selected[0] ? { ctx: selected[0], group, version, kind } : undefined}
              onApply={async (text) => {
                await create.mutateAsync({ ctx: selected[0]!, yamlBody: text });
                setCreateOpen(false);
              }}
              onDryRun={(text) => dryRun.mutateAsync({ ctx: selected[0]!, yamlBody: text })}
            />
          </DialogContent>
        </Dialog>
      )}
      </Box>
      <EmbeddedResourceDetail />
    </Box>
  );
}

/** Compact cluster/namespace/name listing shown in bulk-action confirms. */
function BulkTargetList({ rows }: { rows: ClusterRow[] }) {
  const shown = rows.slice(0, 8);
  const more = rows.length - shown.length;
  return (
    <Box component="ul" sx={{ my: 1, pl: 2.5, fontFamily: 'monospace', fontSize: 12 }}>
      {shown.map((row) => (
        <li key={row.obj.metadata.uid}>
          {row.ctx}: {row.obj.metadata.namespace ? `${row.obj.metadata.namespace}/` : ''}
          {row.obj.metadata.name}
        </li>
      ))}
      {more > 0 && <li>… and {more} more</li>}
    </Box>
  );
}

function createTemplate(kind: string, group: string, version: string): string {
  const apiVersion = group ? `${group}/${version}` : version;
  return `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: my-${kind.toLowerCase()}\n  namespace: default\nspec: {}\n`;
}
