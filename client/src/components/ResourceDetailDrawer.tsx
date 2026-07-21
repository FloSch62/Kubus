import { useEffect, useMemo, useState } from 'react';
import { layout } from '../theme.js';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import type { SxProps, Theme } from '@mui/material/styles';
import { dump as dumpYaml } from 'js-yaml';
import { gvkForResource, type KubeObject } from '@kubus/shared';
import { useApplyResource, useDryRunResource, useResource, useResourceEvents } from '../api/queries.js';
import { withoutManagedFields } from '../kube-display.js';
import { isTextEntryTarget } from '../text-entry.js';
import { YamlEditor, useYamlSchema } from './YamlEditor.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { GenericDetail } from './detail/GenericDetail.js';
import { ConfigMapDetail } from './detail/ConfigMapDetail.js';
import { DataEditor } from './detail/DataEditor.js';
import { DeploymentDetail } from './detail/DeploymentDetail.js';
import { PodDetail } from './detail/PodDetail.js';
import { NodeDetail } from './detail/NodeDetail.js';
import { ServiceDetail } from './detail/ServiceDetail.js';
import { SecretDetail } from './detail/SecretDetail.js';
import { CertificateDetail } from './detail/CertificateDetail.js';
import { CrdDetail, CrdSchemaDetail, crdVersions } from './detail/CrdDetail.js';
import { CustomResourceDetail } from './detail/CustomResourceDetail.js';
import { RolloutHistory } from './detail/RolloutHistory.js';
import { AgeCell } from './AgeCell.js';
import { MetricsChart } from './MetricsChart.js';
import { RowActions, RowLogsButton } from './RowActions.js';
import { TopologyGraph } from './TopologyGraph.js';
import { useDetailStore } from '../state/detail.js';

export interface ResourceSelection {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
  custom?: boolean;
}

interface Props {
  sel: ResourceSelection | undefined;
  onClose: () => void;
  onBack?: () => void;
  inline?: boolean;
}

export function ResourceDetailDrawer({ sel, onClose, onBack, inline = false }: Props) {
  const [tab, setTab] = useState('overview');
  const [reveal, setReveal] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const pushDetail = useDetailStore((s) => s.push);
  // Leaving the Data tab drops its staged per-key edits. The guard lives in
  // the detail store because selection replacements (row clicks, topology,
  // search) bypass the drawer entirely; the drawer routes its own affordances
  // (tab switch, back, close) through the same guard and dialog.
  const guardLeave = useDetailStore((s) => s.guard);
  const setDataDirty = useDetailStore((s) => s.setDataDirty);
  const pendingDiscard = useDetailStore((s) => s.pendingDiscard);
  const confirmDiscard = useDetailStore((s) => s.confirmDiscard);
  const cancelDiscard = useDetailStore((s) => s.cancelDiscard);
  const registeredKind = sel && gvkForResource(sel.group, sel.version, sel.plural)?.kind;
  const isCrdResource = sel?.group === 'apiextensions.k8s.io' && sel.version === 'v1' && sel.plural === 'customresourcedefinitions';
  const behaviorKind = sel && (registeredKind === sel.kind || isCrdResource) ? sel.kind : undefined;
  const isSecret = behaviorKind === 'Secret';
  const hasDataTab = isSecret || behaviorKind === 'ConfigMap';
  const isCrd = isCrdResource && sel?.kind === 'CustomResourceDefinition';
  const backingCrdSelection = sel?.custom && !isCrd && sel.group
    ? {
        ctx: sel.ctx,
        group: 'apiextensions.k8s.io',
        version: 'v1',
        plural: 'customresourcedefinitions',
        kind: 'CustomResourceDefinition',
        name: `${sel.plural}.${sel.group}`,
      }
    : undefined;

  // Reset per-resource view state when the selection changes.
  const selKey = sel ? `${sel.ctx}|${sel.group}|${sel.version}|${sel.plural}|${sel.namespace ?? ''}|${sel.name}` : '';
  useEffect(() => {
    setTab('overview');
    setReveal(false);
  }, [selKey]);

  const hasSel = !!sel;
  useEffect(() => {
    if (!hasSel) setFullScreen(false);
  }, [hasSel]);

  // Live-refresh the object while Overview is showing so stuck pods, rollouts
  // and conditions update in place; other tabs (YAML editing!) keep the
  // snapshot they opened with.
  const { data: obj, refetch } = useResource(sel ? { ...sel, reveal: isSecret && reveal } : undefined, {
    liveMs: tab === 'overview' ? 5000 : undefined,
  });
  const { data: backingCrd } = useResource(backingCrdSelection);
  const { data: events } = useResourceEvents(tab === 'events' && sel ? { ctx: sel.ctx, name: sel.name, kind: sel.kind, namespace: sel.namespace } : undefined);
  const apply = useApplyResource();
  const dryRun = useDryRunResource();
  // Warm the schema (fetch + yaml-worker registration) while the drawer is on
  // Overview, so hover/validation are ready the moment the YAML tab opens.
  useYamlSchema(sel ? { ctx: sel.ctx, group: sel.group, version: sel.version, kind: sel.kind } : undefined);

  // Only serialize on the YAML tab — dumping a large object mid-open would
  // stall the drawer's slide-in animation.
  const yamlText = useMemo(
    () => (obj && tab === 'yaml' ? dumpYaml(withoutManagedFields(obj), { noRefs: true, lineWidth: 140 }) : ''),
    [obj, tab],
  );
  const schemaSource = isCrd ? obj : backingCrd;
  const versions = useMemo(() => crdVersions(schemaSource), [schemaSource]);
  const hasMetrics = behaviorKind === 'Pod' || behaviorKind === 'Node';
  const hasRolloutHistory = behaviorKind === 'Deployment' || behaviorKind === 'StatefulSet' || behaviorKind === 'DaemonSet';
  const showMap = !isCrd;
  const drawerTopOffset = layout.topBarHeight;
  const drawerPaperSx = {
    top: `${drawerTopOffset}px`,
    height: `calc(100% - ${drawerTopOffset}px)`,
  };
  const inlinePaperSx: SxProps<Theme> = fullScreen
    ? {
        position: 'fixed',
        top: `${drawerTopOffset}px`,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: `calc(100% - ${drawerTopOffset}px)`,
        border: 0,
        zIndex: (theme) => theme.zIndex.modal,
      }
    : { position: 'relative', inset: 0, width: '100%', height: '100%', border: 0, zIndex: 'auto' };
  const drawerWidth = fullScreen
    ? '100vw'
    : tab === 'map'
      ? 'min(1060px, 92vw)'
      : 'min(720px, 80vw)';
  const mapNamespaces = sel?.namespace ? [sel.namespace] : [];

  const handleApply = async (text: string) => {
    if (!sel) return;
    try {
      await apply.mutateAsync({ ...sel, yamlBody: text });
    } catch (err) {
      // 409 → refresh so the editor shows the server's current state on Reset.
      if ((err as { status?: number }).status === 409) {
        void refetch();
        throw new Error(`${(err as Error).message} — the resource changed on the server; the view has been refreshed, re-apply your edits.`);
      }
      throw err;
    }
  };

  return (
    <Drawer
      anchor="right"
      variant={inline ? 'permanent' : 'temporary'}
      open={inline || !!sel}
      onClose={() => guardLeave(onClose)}
      sx={
        inline
          ? {
              width: '100%',
              height: '100%',
              // zIndex auto: embedded in the page flow, the paper must not
              // keep the drawer's modal-level 1200 or it buries the panel's
              // collapse/resize handles.
              '& .MuiDrawer-paper': inlinePaperSx,
            }
          : undefined
      }
      slotProps={{
        backdrop: { invisible: true },
        paper: { sx: inline ? undefined : { ...drawerPaperSx, width: drawerWidth, maxWidth: '100vw' } },
      }}
    >
      {sel && (
        <Box
          onKeyDown={(e) => {
            // Alt+← steps back through the related-resource stack — but not
            // while typing (macOS Option+← moves the caret by word).
            if (e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey && onBack && !isTextEntryTarget(e.target)) {
              e.preventDefault();
              e.stopPropagation();
              guardLeave(onBack);
            }
          }}
          sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <Stack direction="row" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}>
            {onBack && (
              <IconButton onClick={() => guardLeave(onBack)} sx={{ mr: 1 }}>
                <ArrowBackIcon />
              </IconButton>
            )}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                {sel.ctx} ·{' '}
                {backingCrdSelection ? (
                  <Link
                    component="button"
                    variant="caption"
                    underline="hover"
                    title={`Open CRD ${backingCrdSelection.name}`}
                    onClick={() => pushDetail(backingCrdSelection)}
                    sx={{ fontWeight: 600, verticalAlign: 'baseline' }}
                  >
                    {sel.kind}
                  </Link>
                ) : (
                  <Typography component="span" variant="caption" color="primary.main" sx={{ fontWeight: 600 }}>
                    {sel.kind}
                  </Typography>
                )}
                {obj && (
                  <>
                    {' · '}
                    <AgeCell timestamp={obj.metadata.creationTimestamp} variant="caption" /> old
                  </>
                )}
              </Typography>
              <Typography variant="subtitle1" noWrap sx={{ fontWeight: 650, lineHeight: 1.3 }}>
                {sel.namespace && (
                  <Typography component="span" variant="subtitle1" color="text.secondary" sx={{ fontWeight: 500 }}>
                    {sel.namespace}{' / '}
                  </Typography>
                )}
                {sel.name}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            {obj && <RowLogsButton target={{ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, kind: sel.kind, obj }} />}
            {obj && <RowActions target={{ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, kind: sel.kind, obj }} />}
            {(!inline || tab === 'map') && (
              <Tooltip title={fullScreen ? 'Restore drawer' : 'Full screen'}>
                <IconButton onClick={() => setFullScreen((v) => !v)} aria-label={fullScreen ? 'Restore drawer' : 'Full screen'}>
                  {fullScreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
                </IconButton>
              </Tooltip>
            )}
            <IconButton onClick={() => guardLeave(onClose)} aria-label="Close resource details">
              <CloseIcon />
            </IconButton>
          </Stack>
          <Tabs
            value={tab}
            onChange={(_e, v) => guardLeave(() => setTab(v as string))}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}
          >
            <Tab value="overview" label="Overview" sx={{ minHeight: 36 }} />
            {hasDataTab && <Tab value="data" label="Data" sx={{ minHeight: 36 }} />}
            {versions.map((v) => (
              <Tab key={v.name} value={`crd:${v.name}`} label={v.name} sx={{ minHeight: 36 }} />
            ))}
            {showMap && <Tab value="map" label="Map" sx={{ minHeight: 36 }} />}
            <Tab value="yaml" label="YAML" sx={{ minHeight: 36 }} />
            <Tab value="events" label="Events" sx={{ minHeight: 36 }} />
            {hasMetrics && <Tab value="metrics" label="Metrics" sx={{ minHeight: 36 }} />}
            {hasRolloutHistory && <Tab value="history" label="History" sx={{ minHeight: 36 }} />}
          </Tabs>
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {tab === 'overview' && obj && <OverviewForKind kind={behaviorKind} obj={obj} ctx={sel.ctx} crd={isCrd ? undefined : backingCrd} version={sel.version} />}
            {hasDataTab && tab === 'data' && (
              <DataEditor
                key={selKey}
                sel={{ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, kind: sel.kind, name: sel.name, namespace: sel.namespace }}
                isSecret={isSecret}
                onDirtyChange={setDataDirty}
              />
            )}
            {tab.startsWith('crd:') && schemaSource && <CrdSchemaDetail obj={schemaSource} versionName={tab.slice('crd:'.length)} />}
            {showMap && tab === 'map' && (
              <Box sx={{ height: '100%', p: 1.25 }}>
                <TopologyGraph
                  contexts={[sel.ctx]}
                  namespaces={mapNamespaces}
                  focus={{
                    group: sel.group,
                    version: sel.version,
                    plural: sel.plural,
                    kind: sel.kind,
                    name: sel.name,
                    namespace: sel.namespace,
                    depth: 2,
                  }}
                  hideDisconnected={false}
                  emptyTitle="No related resources found"
                />
              </Box>
            )}
            {tab === 'yaml' && (
              <YamlEditor
                value={yamlText}
                applyLabel="Replace"
                onApply={handleApply}
                onDryRun={sel ? (text) => dryRun.mutateAsync({ ctx: sel.ctx, yamlBody: text }) : undefined}
                schema={sel ? { ctx: sel.ctx, group: sel.group, version: sel.version, kind: sel.kind } : undefined}
                toolbar={
                  isSecret ? (
                    <FormControlLabel
                      control={<Switch size="small" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />}
                      label={<Typography variant="caption">Reveal secret data</Typography>}
                    />
                  ) : undefined
                }
              />
            )}
            {tab === 'events' && <EventsList events={events?.items ?? []} />}
            {tab === 'metrics' && hasMetrics && (
              <MetricsChart ctx={sel.ctx} kind={behaviorKind === 'Pod' ? 'pod' : 'node'} name={sel.name} namespace={sel.namespace} />
            )}
            {tab === 'history' && hasRolloutHistory && obj && (
              <RolloutHistory ctx={sel.ctx} kind={sel.kind as 'Deployment' | 'StatefulSet' | 'DaemonSet'} obj={obj} />
            )}
          </Box>
          <ConfirmDialog
            open={!!pendingDiscard}
            title="Discard data changes?"
            message="The Data tab has key edits that have not been applied. Leaving discards them."
            confirmLabel="Discard"
            danger
            onConfirm={confirmDiscard}
            onClose={cancelDiscard}
          />
        </Box>
      )}
    </Drawer>
  );
}

export function ResourceDetailPanel(props: Omit<Props, 'inline'>) {
  return <ResourceDetailDrawer {...props} inline />;
}

function OverviewForKind({ kind, obj, ctx, crd, version }: { kind: string | undefined; obj: KubeObject; ctx: string; crd?: KubeObject; version: string }) {
  switch (kind) {
    case 'Deployment':
      return <DeploymentDetail obj={obj} ctx={ctx} />;
    case 'Pod':
      return <PodDetail obj={obj} ctx={ctx} />;
    case 'Node':
      return <NodeDetail obj={obj} ctx={ctx} />;
    case 'Service':
      return <ServiceDetail obj={obj} ctx={ctx} />;
    case 'ConfigMap':
      return <ConfigMapDetail obj={obj} ctx={ctx} />;
    case 'Secret':
      return <SecretDetail obj={obj} ctx={ctx} />;
    case 'CustomResourceDefinition':
      return <CrdDetail obj={obj} ctx={ctx} />;
    default:
      // cert-manager Certificates get an expiry/renewal headline the printer
      // columns don't surface.
      if (crd?.metadata.name === 'certificates.cert-manager.io') {
        return <CertificateDetail obj={obj} ctx={ctx} crd={crd} version={version} />;
      }
      // Custom resources with their backing CRD loaded get a status-aware
      // overview driven by the CRD's printer columns.
      return crd ? <CustomResourceDetail obj={obj} ctx={ctx} crd={crd} version={version} /> : <GenericDetail obj={obj} ctx={ctx} />;
  }
}

function EventsList({ events }: { events: KubeObject[] }) {
  if (!events.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        No events.
      </Typography>
    );
  }
  return (
    <Stack spacing={1} sx={{ p: 2 }}>
      {events.map((e) => {
        const ev = e as KubeObject & { type?: string; reason?: string; message?: string; count?: number; lastTimestamp?: string };
        return (
          <Box key={e.metadata.uid} sx={{ borderLeft: 3, borderColor: ev.type === 'Warning' ? 'error.main' : 'success.main', pl: 1.5, py: 0.25 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {ev.reason} {ev.count && ev.count > 1 ? `×${ev.count}` : ''}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                <AgeCell timestamp={ev.lastTimestamp ?? e.metadata.creationTimestamp} /> ago
              </Typography>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {ev.message}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}
