import { useEffect, useMemo, useState } from 'react';
import { layout } from '../theme.js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import type { SxProps, Theme } from '@mui/material/styles';
import { gvkForResource, type KubeObject } from '@kubus/shared';
import { isResourceGone, useApplyResource, useDryRunResource, useResource, useResourceEvents } from '../api/queries.js';
import { jobPhase, nodeStatus, podSummary, withoutManagedFields, workloadStatus } from '../kube-display.js';
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
import { ManifestView } from './detail/ManifestView.js';
import { dumpManifest, parseYamlMapping, rebaseEdits } from './detail/manifest-tree.js';
import { maskSecretValues } from './detail/data-editor.js';
import { RolloutHistory } from './detail/RolloutHistory.js';
import { AgeCell } from './AgeCell.js';
import { CopyValueButton } from './CellCopy.js';
import { MetricsChart } from './MetricsChart.js';
import { DetailQuickActions } from './RowActions.js';
import { StatusChip } from './StatusChip.js';
import { TruncationTooltip } from './truncation.js';
import { TopologyGraph } from './TopologyGraph.js';
import { useDetailStore, type ManifestDraft } from '../state/detail.js';
import { useUiPrefsStore, type ManifestViewMode } from '../state/prefs.js';
import { showToast } from '../state/toast.js';

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
  const [tabError, setTabError] = useState<string>();
  const [reveal, setReveal] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const pushDetail = useDetailStore((s) => s.push);
  // Leaving the drawer drops staged edits: the Data tab's per-key edits and
  // the Manifest/YAML draft. The guard lives in the detail store because
  // selection replacements (row clicks, topology, search) bypass the drawer
  // entirely; the drawer routes its own affordances (back, close, leaving a
  // dirty Data tab) through the same guard and dialog. The manifest draft
  // survives tab switches, so only the Data tab guards those.
  const guardLeave = useDetailStore((s) => s.guard);
  const dataDirty = useDetailStore((s) => s.dataDirty);
  const setDataDirty = useDetailStore((s) => s.setDataDirty);
  const storeSetDraft = useDetailStore((s) => s.setDraft);
  const clearDraft = useDetailStore((s) => s.clearDraft);
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
    setTabError(undefined);
    setReveal(false);
  }, [selKey]);
  const draft = useDetailStore((s) => s.drafts[selKey]);
  const setDraft = (next: ManifestDraft | undefined) => (next ? storeSetDraft(next) : clearDraft(selKey));
  // The Manifest tab shows the object as a tree or as YAML. A draft pins the
  // view to its own mode (switching converts it); otherwise the preference applies.
  const preferredView = useUiPrefsStore((s) => s.manifestView);
  const setPrefs = useUiPrefsStore((s) => s.set);
  const view: ManifestViewMode = draft ? draft.mode : preferredView;

  const hasSel = !!sel;
  useEffect(() => {
    if (!hasSel) setFullScreen(false);
  }, [hasSel]);

  // Live-refresh the object while Overview or the Manifest tree is showing so
  // stuck pods, rollouts and conditions update in place — fed by the watch
  // stream so it keeps pace with the tables, with the poll as fallback. The
  // YAML view keeps the snapshot it opened with (an editor that reloads under
  // the cursor is unusable); a manifest draft freezes its own base.
  const liveTab = tab === 'overview' || (tab === 'manifest' && view === 'tree');
  const { data: obj, refetch, error } = useResource(sel ? { ...sel, reveal: isSecret && reveal } : undefined, {
    liveMs: liveTab ? 5000 : undefined,
    watch: liveTab,
  });
  // The last state stays on screen for post-mortem, but the drawer must say
  // the object is gone instead of freezing on e.g. "Terminating" forever.
  const objGone = !!obj && isResourceGone(error);
  // Secret manifests are edited from the revealed object so an apply never
  // writes the redaction placeholders back; the tree and the YAML view mask
  // the values until the reveal switch is on. Revealed reads stay on the poll
  // (the watch stream carries redacted objects).
  const { data: revealedSecret, refetch: refetchRevealed } = useResource(isSecret && tab === 'manifest' && sel ? { ...sel, reveal: true } : undefined, {
    liveMs: view === 'tree' ? 5000 : undefined,
  });
  const manifestObj = isSecret ? revealedSecret : obj;
  const secretMasked = isSecret && !reveal;
  const { data: backingCrd } = useResource(backingCrdSelection);
  const { data: events } = useResourceEvents(tab === 'events' && sel ? { ctx: sel.ctx, name: sel.name, kind: sel.kind, namespace: sel.namespace } : undefined);
  const apply = useApplyResource();
  const dryRun = useDryRunResource();
  // Warm the schema (fetch + yaml-worker registration) while the drawer is on
  // Overview, so hover/validation are ready the moment the YAML view opens.
  useYamlSchema(sel ? { ctx: sel.ctx, group: sel.group, version: sel.version, kind: sel.kind } : undefined);

  const liveBase = useMemo(() => (manifestObj ? withoutManagedFields(manifestObj) : undefined), [manifestObj]);
  const showYaml = tab === 'manifest' && view === 'yaml';
  // Only serialize for the YAML view — dumping a large object mid-open would
  // stall the drawer's slide-in animation. An unrevealed Secret shows masked
  // text, read-only, so nothing can be typed over placeholders.
  const yamlText = useMemo(() => (liveBase && showYaml ? dumpManifest(secretMasked ? maskAll(liveBase) : liveBase) : ''), [liveBase, showYaml, secretMasked]);
  // The editor measures dirtiness against the draft's base, and starts from
  // the carried-over text when the draft came from the tree.
  const yamlValue = draft ? (secretMasked ? dumpManifest(maskAll(draft.base)) : draft.baseText) : yamlText;
  // Masked Secret YAML shows the draft re-serialized from its parsed form;
  // text that does not parse cannot be masked, so it stays hidden until revealed.
  const yamlDraftText = useMemo(() => {
    if (draft?.mode !== 'yaml') return undefined;
    if (!secretMasked) return draft.text;
    const parsed = parseYamlMapping(draft.text);
    return parsed.ok ? dumpManifest(maskAll(parsed.value as KubeObject)) : undefined;
  }, [draft, secretMasked]);
  const hiddenUnparsableDraft = secretMasked && draft?.mode === 'yaml' && yamlDraftText === undefined;

  // Tree ⇄ YAML share one draft: entering the tree parses the YAML
  // (unparsable text stays in the editor until fixed), entering the editor
  // serializes the tree. The chosen view is remembered.
  const switchView = (next: ManifestViewMode) => {
    setTabError(undefined);
    if (next === view) return;
    if (draft?.mode === 'yaml') {
      const parsed = parseYamlMapping(draft.text);
      if (!parsed.ok) {
        setTabError(`The YAML does not parse — fix it or reset the editor before switching to the tree. ${parsed.error}`);
        return;
      }
      setDraft({ ...draft, obj: parsed.value as KubeObject, mode: 'tree' });
    } else if (draft?.mode === 'tree') {
      setDraft({ ...draft, text: dumpManifest(draft.obj), mode: 'yaml' });
    }
    setPrefs({ manifestView: next });
  };
  const switchTab = (next: string) => {
    setTabError(undefined);
    setTab(next);
  };
  const viewToggle = <ManifestViewToggle view={view} onChange={switchView} />;

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
      : tab === 'manifest'
        ? 'min(980px, 92vw)'
        : 'min(720px, 80vw)';
  const mapNamespaces = sel?.namespace ? [sel.namespace] : [];

  const handleApply = async (text: string) => {
    if (!sel) return;
    try {
      await apply.mutateAsync({ ...sel, yamlBody: text });
      setDraft(undefined);
    } catch (err) {
      // 409 → refresh, then replay the edits onto the server's current state
      // (picking up its resourceVersion) so the next apply can succeed.
      if ((err as { status?: number }).status === 409) {
        const latest = (await (isSecret ? refetchRevealed() : refetch()))?.data;
        const current = useDetailStore.getState().drafts[selKey];
        let outcome = 'the resource changed on the server; the editor has been refreshed, re-apply your edits.';
        if (latest && current?.selKey === selKey) {
          const base = withoutManagedFields(latest);
          const baseText = dumpManifest(base);
          const parsed = current.mode === 'yaml' ? parseYamlMapping(current.text) : undefined;
          if (parsed?.ok) {
            const { value, skipped } = rebaseEdits(current.base, parsed.value, base);
            setDraft({ ...current, base, baseText, obj: value, text: dumpManifest(value) });
            outcome = `the resource changed on the server; your edits were replayed onto the latest version${skipped.length ? ` (${skipped.length} to list items that no longer exist were dropped)` : ''} — dry-run and apply again.`;
          } else {
            setDraft({ ...current, base, baseText, obj: base, text: current.mode === 'yaml' ? current.text : baseText });
          }
        }
        throw new Error(`${(err as Error).message} — ${outcome}`);
      }
      throw err;
    }
  };
  const revealToggle = isSecret ? (
    <FormControlLabel
      control={<Switch size="small" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />}
      label={<Typography variant="caption">Reveal secret data</Typography>}
    />
  ) : undefined;

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
          <Stack direction="row" sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider', alignItems: 'center', gap: 1 }}>
            {onBack && (
              <IconButton aria-label="Back" size="small" onClick={() => guardLeave(onBack)} sx={{ ml: -0.5 }}>
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            )}
            <Box sx={{ minWidth: 0, flex: 1 }}>
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
              <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                <TruncationTooltip text={sel.namespace ? `${sel.namespace} / ${sel.name}` : sel.name}>
                  <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600, fontSize: 15.5, lineHeight: 1.3, minWidth: 0 }}>
                    {sel.namespace && (
                      <Typography component="span" variant="subtitle1" color="text.secondary" sx={{ fontWeight: 500, fontSize: 'inherit' }}>
                        {sel.namespace}{' / '}
                      </Typography>
                    )}
                    {sel.name}
                  </Typography>
                </TruncationTooltip>
                <CopyValueButton text={sel.name} label={`Copy name ${sel.name}`} />
              </Stack>
            </Box>
            {obj && (objGone || headerStatus(behaviorKind, obj)) && (
              <Box sx={{ flexShrink: 0, px: 0.5 }}>
                <StatusChip status={objGone ? 'Deleted' : headerStatus(behaviorKind, obj)!} size="md" />
              </Box>
            )}
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
          {objGone && (
            <Alert severity="warning" sx={{ borderRadius: 0, py: 0 }}>
              Deleted from the cluster — showing the last known state.
            </Alert>
          )}
          {obj && !objGone && <DetailQuickActions target={{ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, kind: sel.kind, obj }} />}
          <Tabs
            value={tab}
            onChange={(_e, v) => (dataDirty ? guardLeave(() => switchTab(v as string)) : switchTab(v as string))}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}
          >
            <Tab value="overview" label="Overview" sx={{ minHeight: 36 }} />
            <Tab
              value="manifest"
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  Manifest
                  {draft && <Box component="span" aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main' }} />}
                </Box>
              }
              title={draft ? 'Unapplied edits' : undefined}
              sx={{ minHeight: 36 }}
            />
            {hasDataTab && <Tab value="data" label="Data" sx={{ minHeight: 36 }} />}
            {versions.length > 0 && <Tab value="schema" label="Schema" sx={{ minHeight: 36 }} />}
            {showMap && <Tab value="map" label="Map" sx={{ minHeight: 36 }} />}
            <Tab value="events" label="Events" sx={{ minHeight: 36 }} />
            {hasMetrics && <Tab value="metrics" label="Metrics" sx={{ minHeight: 36 }} />}
            {hasRolloutHistory && <Tab value="history" label="History" sx={{ minHeight: 36 }} />}
          </Tabs>
          {tabError && (
            <Alert severity="error" onClose={() => setTabError(undefined)} sx={{ borderRadius: 0, flexShrink: 0 }}>
              {tabError}
            </Alert>
          )}
          {hiddenUnparsableDraft && showYaml && (
            <Alert severity="info" sx={{ borderRadius: 0, flexShrink: 0 }}>
              Your YAML edits are hidden while the Secret is masked because they do not parse. Reveal the Secret to continue editing them.
            </Alert>
          )}
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {tab === 'manifest' && manifestObj && view === 'tree' && (
              <ManifestView
                sel={sel}
                live={manifestObj}
                draft={draft?.mode === 'tree' ? draft : undefined}
                readOnly={objGone}
                secretRedacted={secretMasked}
                toolbarStart={viewToggle}
                toolbar={revealToggle}
                onDraftChange={(next, base) =>
                  setDraft(next ? { selKey, base, baseText: draft && draft.base === base ? draft.baseText : dumpManifest(base), obj: next, text: '', mode: 'tree' } : undefined)
                }
                onApplied={() => {
                  setDraft(undefined);
                  showToast('success', `${sel.kind} ${sel.name} updated`);
                  void refetch();
                }}
                onConflict={() => void refetch()}
              />
            )}
            {tab === 'overview' && obj && <OverviewForKind kind={behaviorKind} obj={obj} ctx={sel.ctx} crd={isCrd ? undefined : backingCrd} version={sel.version} />}
            {hasDataTab && tab === 'data' && (
              <DataEditor
                key={selKey}
                sel={{ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, kind: sel.kind, name: sel.name, namespace: sel.namespace }}
                isSecret={isSecret}
                onDirtyChange={setDataDirty}
              />
            )}
            {tab === 'schema' && schemaSource && <CrdSchemaDetail key={selKey} obj={schemaSource} versionName={isCrd ? undefined : sel.version} />}
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
            {showYaml && (
              <YamlEditor
                value={yamlValue}
                draft={yamlDraftText}
                readOnly={secretMasked}
                onChange={(text) => {
                  if (!liveBase || secretMasked) return;
                  setDraft({ selKey, base: draft?.base ?? liveBase, baseText: draft?.baseText ?? yamlText, obj: draft?.obj ?? liveBase, text, mode: 'yaml' });
                }}
                applyLabel="Replace"
                onApply={secretMasked ? undefined : handleApply}
                onDryRun={sel && !secretMasked ? (text) => dryRun.mutateAsync({ ctx: sel.ctx, yamlBody: text }) : undefined}
                schema={sel ? { ctx: sel.ctx, group: sel.group, version: sel.version, kind: sel.kind } : undefined}
                toolbar={
                  <>
                    {viewToggle}
                    {revealToggle}
                    {secretMasked && (
                      <Typography variant="caption" color="text.secondary">
                        Read-only until revealed
                      </Typography>
                    )}
                  </>
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
            title="Discard changes?"
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

/** Every Secret value replaced by the redaction placeholder, for display while not revealed. */
function maskAll(obj: KubeObject): KubeObject {
  return maskSecretValues(obj, () => false);
}

/** Tree / YAML switch at the start of the Manifest toolbar. */
function ManifestViewToggle({ view, onChange }: { view: ManifestViewMode; onChange: (next: ManifestViewMode) => void }) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={view}
      onChange={(_e, next: ManifestViewMode | null) => {
        if (next) onChange(next);
      }}
      aria-label="Manifest view"
      sx={{ flexShrink: 0, '& .MuiToggleButton-root': { px: 1.25, py: 0.25, textTransform: 'none', fontSize: 12.5, lineHeight: 1.7 } }}
    >
      <ToggleButton value="tree">Tree</ToggleButton>
      <ToggleButton value="yaml">YAML</ToggleButton>
    </ToggleButtonGroup>
  );
}


/** Summary status word shown next to the kind in the header, for kinds with a
 *  cheap one-word answer. Others rely on their overview's Status fact. */
function headerStatus(kind: string | undefined, obj: KubeObject): string | undefined {
  switch (kind) {
    case 'Pod':
      return podSummary(obj).status;
    case 'Node':
      return nodeStatus(obj);
    case 'Job':
      return jobPhase(obj);
    case 'CronJob':
      return (obj.spec as { suspend?: boolean } | undefined)?.suspend ? 'Suspended' : undefined;
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
      return workloadStatus(obj);
    default:
      return undefined;
  }
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
          <Box key={e.metadata.uid} sx={{ borderLeft: 3, borderColor: ev.type === 'Warning' ? 'warning.main' : 'success.main', pl: 1.5, py: 0.25 }}>
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
