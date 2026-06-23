import { useEffect, useMemo, useState } from 'react';
import { Box, Drawer, FormControlLabel, IconButton, Stack, Switch, Tab, Tabs, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import yaml from 'js-yaml';
import type { KubeObject } from '@kubus/shared';
import { useApplyResource, useDryRunResource, useResource, useResourceEvents } from '../api/queries.js';
import { withoutManagedFields } from '../kube-display.js';
import { YamlEditor } from './YamlEditor.js';
import { GenericDetail } from './detail/GenericDetail.js';
import { DeploymentDetail } from './detail/DeploymentDetail.js';
import { PodDetail } from './detail/PodDetail.js';
import { NodeDetail } from './detail/NodeDetail.js';
import { ServiceDetail } from './detail/ServiceDetail.js';
import { SecretDetail } from './detail/SecretDetail.js';
import { CrdDetail, CrdSchemaDetail, crdVersions } from './detail/CrdDetail.js';
import { RolloutHistory } from './detail/RolloutHistory.js';
import { AgeCell } from './AgeCell.js';
import { MetricsChart } from './MetricsChart.js';
import { RowActions } from './RowActions.js';
import { TopologyGraph } from './TopologyGraph.js';

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
}

export function ResourceDetailDrawer({ sel, onClose, onBack }: Props) {
  const [tab, setTab] = useState('overview');
  const [reveal, setReveal] = useState(false);
  const isSecret = sel?.kind === 'Secret';
  const isCrd = sel?.kind === 'CustomResourceDefinition';

  // Reset per-resource view state when the selection changes.
  const selKey = sel ? `${sel.ctx}|${sel.kind}|${sel.namespace ?? ''}|${sel.name}` : '';
  useEffect(() => {
    setTab('overview');
    setReveal(false);
  }, [selKey]);
  const { data: obj, refetch } = useResource(sel ? { ...sel, reveal: isSecret && reveal } : undefined);
  const { data: backingCrd } = useResource(
    sel?.custom && !isCrd && sel.group
      ? {
          ctx: sel.ctx,
          group: 'apiextensions.k8s.io',
          version: 'v1',
          plural: 'customresourcedefinitions',
          name: `${sel.plural}.${sel.group}`,
        }
      : undefined,
  );
  const { data: events } = useResourceEvents(tab === 'events' && sel ? { ctx: sel.ctx, name: sel.name, kind: sel.kind, namespace: sel.namespace } : undefined);
  const apply = useApplyResource();
  const dryRun = useDryRunResource();

  const yamlText = useMemo(() => (obj ? yaml.dump(withoutManagedFields(obj), { noRefs: true, lineWidth: 140 }) : ''), [obj]);
  const schemaSource = isCrd ? obj : backingCrd;
  const versions = useMemo(() => crdVersions(schemaSource), [schemaSource]);
  const hasMetrics = sel?.kind === 'Pod' || sel?.kind === 'Node';
  const hasRolloutHistory = sel?.kind === 'Deployment' || sel?.kind === 'StatefulSet';
  const showMap = !isCrd;
  const drawerWidth = tab === 'map' ? 'min(1060px, 92vw)' : tab.startsWith('crd:') ? 'min(920px, 90vw)' : 'min(720px, 80vw)';
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
    <Drawer anchor="right" open={!!sel} onClose={onClose} slotProps={{ paper: { sx: { width: drawerWidth } } }}>
      {sel && (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
            {onBack && (
              <IconButton onClick={onBack} sx={{ mr: 1 }}>
                <ArrowBackIcon />
              </IconButton>
            )}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                {sel.ctx} ·{' '}
                <Typography component="span" variant="caption" color="primary.main" sx={{ fontWeight: 600 }}>
                  {sel.kind}
                </Typography>
                {obj && (
                  <>
                    {' · '}
                    <AgeCell timestamp={obj.metadata.creationTimestamp} /> old
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
            {obj && <RowActions target={{ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, kind: sel.kind, obj }} />}
            <IconButton onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Stack>
          <Tabs
            value={tab}
            onChange={(_e, v) => setTab(v as string)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}
          >
            <Tab value="overview" label="Overview" sx={{ minHeight: 36 }} />
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
            {tab === 'overview' && obj && <OverviewForKind kind={sel.kind} obj={obj} ctx={sel.ctx} />}
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
                onApply={handleApply}
                onDryRun={sel ? (text) => dryRun.mutateAsync({ ctx: sel.ctx, yamlBody: text }) : undefined}
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
              <MetricsChart ctx={sel.ctx} kind={sel.kind === 'Pod' ? 'pod' : 'node'} name={sel.name} namespace={sel.namespace} />
            )}
            {tab === 'history' && hasRolloutHistory && obj && (
              <RolloutHistory ctx={sel.ctx} kind={sel.kind as 'Deployment' | 'StatefulSet'} obj={obj} />
            )}
          </Box>
        </Box>
      )}
    </Drawer>
  );
}

function OverviewForKind({ kind, obj, ctx }: { kind: string; obj: KubeObject; ctx: string }) {
  switch (kind) {
    case 'Deployment':
      return <DeploymentDetail obj={obj} ctx={ctx} />;
    case 'Pod':
      return <PodDetail obj={obj} ctx={ctx} />;
    case 'Node':
      return <NodeDetail obj={obj} ctx={ctx} />;
    case 'Service':
      return <ServiceDetail obj={obj} ctx={ctx} />;
    case 'Secret':
      return <SecretDetail obj={obj} ctx={ctx} />;
    case 'CustomResourceDefinition':
      return <CrdDetail obj={obj} ctx={ctx} />;
    default:
      return <GenericDetail obj={obj} ctx={ctx} />;
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
