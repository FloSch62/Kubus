import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, Link, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SubjectIcon from '@mui/icons-material/Subject';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import { useParams, useSearchParams } from 'react-router';
import { columnsForKind, groupFromPath, groupToPath, gvkForResource, pluralLabel, type ResourceKindInfo } from '@kubus/shared';
import { useApiResourcesForContexts, useCrdColumns, useCreateResource, useDryRunResource, useFilteredList, useResourceMetrics, useWatchedList, type ClusterRow } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useDockStore, dockTabId } from '../state/dock.js';
import { ResourceTable } from '../components/ResourceTable.js';
import { buildColumns, buildCrdColumns, crdHiddenFields, makeMetricsLookup, makeNodeAllocationLookup } from '../components/columns.js';
import type { ResourceSelection } from '../components/ResourceDetailDrawer.js';
import { useDetailStore } from '../state/detail.js';
import { RowActionMenu, RowActions, type RowActionTarget } from '../components/RowActions.js';
import { YamlEditor } from '../components/YamlEditor.js';
import { EmptyState } from '../components/EmptyState.js';
import { useNavigationStore } from '../state/navigation.js';
import { addLabelTerm } from '../label-selector.js';

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
  const resourceTitle = pluralLabel(kind);
  const namespaced = kindInfo?.namespaced ?? true;
  const isCustomKind = !!kindInfo?.custom;

  const [searchParams, setSearchParams] = useSearchParams();
  const textFilter = searchParams.get('q') ?? '';
  const labelSelector = searchParams.get('label') ?? '';

  useEffect(() => {
    if (!searchParams.has('field')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('field');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const list = useFilteredList(group, version, plural, namespaced, { labelSelector });
  const isPodOrNode = kind === 'Pod' || kind === 'Node';
  const { data: podMetrics } = useResourceMetrics(isPodOrNode ? selected : [], kind === 'Node' ? 'nodes' : 'pods');
  const metricsUnavailable = isPodOrNode ? selected.filter((ctx) => podMetrics?.get(ctx)?.available === false) : [];
  const nodePods = useWatchedList(kind === 'Node' ? selected : [], '', 'v1', 'pods');
  const nodeAllocation = useMemo(() => (kind === 'Node' ? makeNodeAllocationLookup(nodePods.rows) : undefined), [kind, nodePods.rows]);

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRows, setSelectedRows] = useState<ClusterRow[]>([]);
  const [contextAction, setContextAction] = useState<{ target: RowActionTarget; mouseX: number; mouseY: number } | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const addTab = useDockStore((s) => s.addTab);
  const create = useCreateResource();
  const dryRun = useDryRunResource();
  const addSavedView = useNavigationStore((s) => s.addSavedView);

  // Detail selection deep-linked via ?sel=ctx|namespace|name
  const sel: ResourceSelection | undefined = useMemo(() => {
    const raw = searchParams.get('sel');
    if (!raw) return undefined;
    const [ctx, namespace, name] = raw.split('|');
    if (!ctx || !name) return undefined;
    return { ctx, group, version, plural, kind, name, namespace: namespace || undefined, custom: isCustomKind };
  }, [searchParams, group, version, plural, kind, isCustomKind]);

  // Mirror the URL selection into the global detail drawer; close on unmount.
  const openDetail = useDetailStore((s) => s.open);
  const closeDetail = useDetailStore((s) => s.close);
  const detailOpen = useDetailStore((s) => s.stack.length > 0);
  useEffect(() => {
    if (sel) openDetail(sel);
    else closeDetail();
  }, [sel, openDetail, closeDetail]);
  useEffect(() => () => closeDetail(), [closeDetail]);
  // Drawer closed via its X → drop the ?sel deep link. The ref guards
  // against clearing on mount, before the mirror effect has opened it.
  const wasDetailOpen = useRef(false);
  useEffect(() => {
    if (wasDetailOpen.current && !detailOpen && searchParams.get('sel')) {
      const next = new URLSearchParams(searchParams);
      next.delete('sel');
      setSearchParams(next);
    }
    wasDetailOpen.current = detailOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailOpen]);

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

  // CRD printer columns: taken from the first selected cluster that serves
  // this GVR — multi-cluster CRD definition drift is not reconciled.
  const crdCtx = useMemo(
    () => selected.find((c) => (apiResources?.byContext[c] ?? []).some((r) => r.group === group && r.version === version && r.plural === plural)),
    [selected, apiResources, group, version, plural],
  );
  const { data: printerCols } = useCrdColumns(crdCtx, group, version, plural, isCustomKind);

  // For CRD-backed kinds the page title links to the defining CRD.
  const pushDetail = useDetailStore((s) => s.push);
  const crdSelection: ResourceSelection | undefined =
    isCustomKind && crdCtx && group
      ? {
          ctx: crdCtx,
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

  const metricsLookup = useMemo(() => makeMetricsLookup(kind, podMetrics), [kind, podMetrics]);

  const columns = useMemo(() => {
    const ids = columnsForKind(kind, namespaced);
    const opts = { multiCluster: selected.length > 1, metrics: metricsLookup, nodeAllocation, onLabelClick: addLabelFilter };
    const cols = buildColumns(ids, opts);
    if (isCustomKind && printerCols?.length) {
      const crdIdx = cols.findIndex((c) => c.field === 'age');
      cols.splice(crdIdx === -1 ? cols.length : crdIdx, 0, ...buildCrdColumns(printerCols));
    }
    // Labels for every kind, right before Age.
    const ageIdx = cols.findIndex((c) => c.field === 'age');
    cols.splice(ageIdx === -1 ? cols.length : ageIdx, 0, ...buildColumns(['labels'], opts));
    cols.push({
      field: '_actions',
      headerName: '',
      width: 50,
      sortable: false,
      filterable: false,
      renderCell: (p) => <RowActions target={rowActionTarget(p.row)} />,
    });
    return cols;
  }, [kind, namespaced, selected.length, metricsLookup, nodeAllocation, isCustomKind, printerCols, rowActionTarget, addLabelFilter]);
  const hiddenFields = useMemo(() => (isCustomKind && printerCols?.length ? crdHiddenFields(printerCols) : []), [isCustomKind, printerCols]);

  const supportsGvr = (r: ResourceKindInfo) => r.group === group && r.version === version && r.plural === plural;
  const discoveryMissing = useMemo(() => {
    if (!apiResources) return [];
    return selected.filter((ctx) => {
      if (apiResources.errors[ctx]) return false;
      return !(apiResources.byContext[ctx] ?? []).some(supportsGvr);
    });
  }, [apiResources, selected, group, version, plural]);
  const unavailable = Object.entries(list.status).filter(([, s]) => s.state === 'unavailable');
  const unavailableContexts = new Set(unavailable.map(([ctx]) => ctx));
  const discoveryOnlyMissing = discoveryMissing.filter((ctx) => !unavailableContexts.has(ctx));
  const errors = Object.entries(list.status).filter(([, s]) => s.state === 'error');

  if (selected.length === 0) {
    return (
      <EmptyState
        icon={<HubOutlinedIcon />}
        title="No cluster selected"
        subtitle="Pick one or more clusters from the switcher in the top bar."
      />
    );
  }

  const multiLogs = kind === 'Pod' && selectedRows.length > 0;
  const kindPath = `/r/${groupToPath(group)}/${version}/${plural}`;

  const saveCurrentView = () => {
    const params = new URLSearchParams();
    if (textFilter.trim()) params.set('q', textFilter.trim());
    if (labelSelector.trim()) params.set('label', labelSelector.trim());
    const path = `${kindPath}${params.toString() ? `?${params.toString()}` : ''}`;
    addSavedView({
      id: `view:${path}`,
      title: `${resourceTitle}${textFilter || labelSelector ? ' view' : ''}`,
      path,
      textFilter: textFilter.trim() || undefined,
      labelSelector: labelSelector.trim() || undefined,
    });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box sx={{ px: 1.5, pt: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {crdSelection ? (
            <Link
              component="button"
              variant="h6"
              underline="hover"
              color="inherit"
              title={`Open CRD ${crdSelection.name}`}
              onClick={() => pushDetail(crdSelection)}
            >
              {resourceTitle}
            </Link>
          ) : (
            <Typography variant="h6">{resourceTitle}</Typography>
          )}
        </Box>
        {errors.map(([ctx, s]) => (
          <Alert key={ctx} severity="error" sx={{ mt: 0.5 }}>
            {ctx}: {s.message ?? 'watch error'}
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
        rows={list.rows}
        columns={columns}
        loading={Object.values(list.status).some((s) => s.state === 'loading')}
        kind={kind}
        metricsLookup={metricsLookup}
        filter={textFilter}
        labelSelector={labelSelector}
        onFilterChange={(value) => setQueryParam('q', value)}
        onLabelSelectorChange={(value) => setQueryParam('label', value)}
        onRowClick={(row) => {
          const next = new URLSearchParams(searchParams);
          next.delete('field');
          next.set('sel', `${row.ctx}|${row.obj.metadata.namespace ?? ''}|${row.obj.metadata.name}`);
          setSearchParams(next);
        }}
        onRowContextMenu={(row, event) => {
          setContextAction({ target: rowActionTarget(row), mouseX: event.clientX + 2, mouseY: event.clientY - 6 });
          setContextMenuOpen(true);
        }}
        checkboxSelection={kind === 'Pod'}
        onSelectionChange={kind === 'Pod' ? setSelectedRows : undefined}
        hiddenFields={hiddenFields}
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
                      follow: true,
                      tailLines: 500,
                    });
                  }
                }}
              >
                Logs ({selectedRows.length})
              </Button>
            )}
            <Button startIcon={<AddIcon />} variant="outlined" onClick={() => setCreateOpen(true)}>
              Create
            </Button>
          </>
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
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: '80vh' } } }}>
        <DialogTitle>Create resource{selected.length > 1 ? ` on ${selected[0]}` : ''}</DialogTitle>
        <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
          <YamlEditor
            value={createTemplate(kind, group, version)}
            applyLabel="Create"
            onApply={async (text) => {
              await create.mutateAsync({ ctx: selected[0]!, yamlBody: text });
              setCreateOpen(false);
            }}
            onDryRun={(text) => dryRun.mutateAsync({ ctx: selected[0]!, yamlBody: text })}
          />
        </DialogContent>
      </Dialog>
    </Box>
  );
}

function createTemplate(kind: string, group: string, version: string): string {
  const apiVersion = group ? `${group}/${version}` : version;
  return `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: my-${kind.toLowerCase()}\n  namespace: default\nspec: {}\n`;
}
