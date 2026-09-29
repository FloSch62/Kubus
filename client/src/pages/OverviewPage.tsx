import { lazy, Suspense, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import QueryStatsOutlinedIcon from '@mui/icons-material/QueryStatsOutlined';
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router';
import type { ClusterOverview, MetricsSnapshot } from '@kubus/shared';
import { useContexts, useKubeconfigSettings, useNodeMetrics, useOverview, useOverviewCertificates, useOverviewOperators } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { ClusterSectionHeader } from '../components/ClusterSectionHeader.js';
import { InstallMetricsServerButton } from '../components/MetricsServerControls.js';
import { PageHeader } from '../components/PageHeader.js';
import { formatBytes, formatCpu } from '../components/format.js';
import { AttentionTiles, InventoryButton, InventoryRow, OverviewLabel } from '../components/overview/Attention.js';
import { attentionItems } from '../components/overview/attention-items.js';
import { CertExpiryCard } from '../components/overview/CertExpiryCard.js';
import { FailingPodsCard, ProblemCard, WarningEventsCard } from '../components/overview/cards.js';
import { kindIcon } from '../components/overview/kind-icons.js';
import { NamespaceOverviewSection } from '../components/overview/NamespaceOverviewSection.js';
import { OperatorSection } from '../components/overview/OperatorSection.js';
import { PodUsagePanels } from '../components/overview/PodUsagePanels.js';
import { WorkloadHealthSection, unhealthyListPath } from '../components/overview/WorkloadHealthSection.js';

// Adding a cluster pulls the settings chunk (js-yaml); keep it lazy here.
const AddClusterDialog = lazy(() => import('../components/settings/AddClusterDialog.js').then((m) => ({ default: m.AddClusterDialog })));

const HEALTH_COLOR: Record<string, string> = { connected: 'success.main', connecting: 'warning.main', error: 'error.main' };

/**
 * First-run path: instead of pointing at the cluster switcher, list the
 * kubeconfig's contexts for one-click connect, or lead straight into the
 * add-cluster flow when the kubeconfig is empty.
 */
function WelcomeState() {
  // Selecting drives the ClusterSwitcher's keep-healthy effect, which owns
  // connecting — no second connect path here.
  const setSelected = useClustersStore((s) => s.setSelected);
  const { data: contexts, isLoading } = useContexts({ poll: false });
  const { data: kubeconfig } = useKubeconfigSettings();
  const [addOpen, setAddOpen] = useState(false);
  const shown = (contexts ?? []).slice(0, 8);

  return (
    <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', p: 3, minHeight: '100%' }} spacing={2}>
      <Box component="img" src="/kubus.svg" alt="" aria-hidden sx={{ width: 48, height: 54, objectFit: 'contain' }} />
      <Typography variant="h5" sx={{ fontWeight: 700 }}>
        Welcome to Kubus
      </Typography>
      {isLoading && <CircularProgress size={22} />}
      {!isLoading && shown.length > 0 && (
        <>
          <Typography variant="body2" color="text.secondary">
            Pick a cluster from your kubeconfig to get started.
          </Typography>
          <Stack spacing={1} sx={{ width: 'min(520px, 100%)' }}>
            {shown.map((c) => (
              <ButtonBase
                key={c.name}
                onClick={() => setSelected([c.name])}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 1.75,
                  py: 1.25,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1.5,
                  textAlign: 'left',
                  justifyContent: 'flex-start',
                  '&:hover': { bgcolor: 'action.hover', borderColor: 'primary.main' },
                }}
              >
                <Box sx={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, bgcolor: HEALTH_COLOR[c.health] ?? 'text.disabled' }} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                    {c.name}
                  </Typography>
                  {c.server && (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                      {c.server}
                    </Typography>
                  )}
                </Box>
                {c.current && <Chip label="current" size="small" variant="outlined" sx={{ flexShrink: 0 }} />}
              </ButtonBase>
            ))}
            {(contexts?.length ?? 0) > shown.length && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                …and {(contexts?.length ?? 0) - shown.length} more in the cluster switcher above.
              </Typography>
            )}
          </Stack>
        </>
      )}
      {!isLoading && shown.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 440, textAlign: 'center' }}>
          No clusters found in your kubeconfig. Add one by pasting a kubeconfig or entering connection details.
        </Typography>
      )}
      <Button variant={shown.length === 0 ? 'contained' : 'outlined'} startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
        Add cluster
      </Button>
      {addOpen && (
        <Suspense fallback={null}>
          <AddClusterDialog primaryPath={kubeconfig?.primaryPath ?? null} onClose={() => setAddOpen(false)} />
        </Suspense>
      )}
    </Stack>
  );
}

export function OverviewPage() {
  const selected = useClustersStore((s) => s.selected);

  if (selected.length === 0) {
    return <WelcomeState />;
  }

  return (
    <Box sx={{ p: 2 }}>
      <PageHeader title="Overview" icon={<SpaceDashboardOutlinedIcon />}>
        {selected.length > 1 && (
          <Typography variant="body2" color="text.secondary">
            {selected.length} clusters
          </Typography>
        )}
      </PageHeader>
      <Stack spacing={4}>
        {selected.map((ctx) => (
          <ClusterOverviewSection key={ctx} ctx={ctx} />
        ))}
      </Stack>
    </Box>
  );
}

const EMPTY_NAMESPACES: string[] = [];

function ClusterOverviewSection({ ctx }: { ctx: string }) {
  // The namespace filter scopes the whole overview: with namespaces selected
  // for this cluster in the nav, its section becomes the namespace-level view.
  const namespaces = useClustersStore((s) => s.namespacesByContext[ctx] ?? EMPTY_NAMESPACES);

  return (
    <Box data-overview-section={ctx}>
      <ClusterSectionHeader ctx={ctx} />
      {namespaces.length > 0 ? <NamespaceOverviewSection ctx={ctx} namespaces={namespaces} /> : <WholeClusterSection ctx={ctx} />}
    </Box>
  );
}

type NodeMetrics = MetricsSnapshot | undefined;

/** Summed usage against summed capacity across the sampled nodes. */
function clusterUsage(nodeMetrics: NodeMetrics) {
  if (!nodeMetrics?.available || nodeMetrics.items.length === 0) return undefined;
  const sampled = nodeMetrics.items.reduce(
    (acc, item) => ({
      cpuMilli: acc.cpuMilli + item.cpuMilli,
      memBytes: acc.memBytes + item.memBytes,
      cpuCapacityMilli: acc.cpuCapacityMilli + (item.cpuCapacityMilli ?? 0),
      memCapacityBytes: acc.memCapacityBytes + (item.memCapacityBytes ?? 0),
    }),
    { cpuMilli: 0, memBytes: 0, cpuCapacityMilli: 0, memCapacityBytes: 0 },
  );
  return {
    ...sampled,
    cpuCapacityMilli: nodeMetrics.totalCpuCapacityMilli ?? sampled.cpuCapacityMilli,
    memCapacityBytes: nodeMetrics.totalMemCapacityBytes ?? sampled.memCapacityBytes,
  };
}

/** "CPU 2% · Memory 4% of 1 node" for the inventory label, with the absolute numbers on hover. */
function UsageSummary({ nodeMetrics, nodes }: { nodeMetrics: NodeMetrics; nodes: number }) {
  const total = clusterUsage(nodeMetrics);
  if (!total) return null;
  const cpu = total.cpuCapacityMilli > 0 ? (total.cpuMilli / total.cpuCapacityMilli) * 100 : undefined;
  const mem = total.memCapacityBytes > 0 ? (total.memBytes / total.memCapacityBytes) * 100 : undefined;
  return (
    <Box
      component="span"
      title={`CPU ${formatCpu(total.cpuMilli)} of ${formatCpu(total.cpuCapacityMilli)} · Memory ${formatBytes(total.memBytes)} of ${formatBytes(total.memCapacityBytes)}`}
    >
      {cpu !== undefined ? `CPU ${cpu.toFixed(0)}%` : `CPU ${formatCpu(total.cpuMilli)}`}
      {' · '}
      {mem !== undefined ? `Memory ${mem.toFixed(0)}%` : `Memory ${formatBytes(total.memBytes)}`}
      {` of ${nodes} ${nodes === 1 ? 'node' : 'nodes'}`}
    </Box>
  );
}

function ClusterInventory({ ctx, data, nodeMetrics }: { ctx: string; data: ClusterOverview; nodeMetrics: NodeMetrics }) {
  const navigate = useNavigate();
  const { counts } = data;
  const podsNotRunning = counts.pods - counts.podsRunning;
  return (
    <Box>
      <OverviewLabel end={<UsageSummary nodeMetrics={nodeMetrics} nodes={counts.nodes} />}>Inventory</OverviewLabel>
      <InventoryRow>
        <InventoryButton icon={kindIcon('Node')} label="Nodes" value={counts.nodes} onClick={() => navigate('/r/core/v1/nodes')} />
        <InventoryButton icon={kindIcon('Namespace')} label="Namespaces" value={counts.namespaces} onClick={() => navigate('/r/core/v1/namespaces')} />
        <InventoryButton
          icon={kindIcon('Pod')}
          label="Pods"
          value={counts.podsRunning}
          sub={` of ${counts.pods} running`}
          title={
            podsNotRunning > 0
              ? `${counts.podsRunning} of ${counts.pods} pods are running. The other ${podsNotRunning} are pending, completed (Job pods) or failed.`
              : `All ${counts.pods} pods are running`
          }
          ariaLabel={`Pods: ${counts.podsRunning} of ${counts.pods} running`}
          onClick={() => navigate('/r/core/v1/pods')}
        />
        <InventoryButton icon={kindIcon('Deployment')} label="Deployments" value={counts.deployments} onClick={() => navigate('/r/apps/v1/deployments')} />
        <InventoryButton
          icon={kindIcon('PersistentVolume')}
          label="PVs"
          value={counts.persistentVolumesUnavailable ? undefined : counts.persistentVolumesBound}
          sub={
            counts.persistentVolumesUnavailable
              ? 'unavailable'
              : counts.persistentVolumes === counts.persistentVolumesBound
                ? ' bound'
                : ` of ${counts.persistentVolumes} bound`
          }
          title="Persistent volumes"
          onClick={() => navigate('/r/core/v1/persistentvolumes')}
        />
        <InventoryButton
          icon={kindIcon('CustomResourceDefinition')}
          label="CRDs"
          value={counts.crdsUnavailable ? undefined : counts.crdsEstablished}
          sub={counts.crdsUnavailable ? 'unavailable' : counts.crds === counts.crdsEstablished ? undefined : ` of ${counts.crds} active`}
          title="Custom resource definitions"
          onClick={() => navigate('/r/apiextensions.k8s.io/v1/customresourcedefinitions')}
        />
        <InventoryButton icon={<QueryStatsOutlinedIcon />} label="Metrics" title="CPU and memory over time" onClick={() => navigate('/metrics')} />
      </InventoryRow>
      <MetricsNotice ctx={ctx} nodeMetrics={nodeMetrics} />
    </Box>
  );
}

/** Explains missing usage numbers, with the install action when metrics-server is absent. */
function MetricsNotice({ ctx, nodeMetrics }: { ctx: string; nodeMetrics: NodeMetrics }) {
  // Before the first poller probe completes, "unavailable" is provisional:
  // say nothing rather than show a false install prompt.
  if (!nodeMetrics?.probed) return null;
  if (!nodeMetrics.available) {
    return (
      <Alert severity="info" variant="outlined" sx={{ mt: 1, alignItems: 'center' }} action={<InstallMetricsServerButton ctx={ctx} />}>
        CPU and memory usage are unavailable because metrics-server is not serving data in this cluster.
      </Alert>
    );
  }
  if (nodeMetrics.items.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
        Waiting for node metrics.
      </Typography>
    );
  }
  return null;
}

function WholeClusterSection({ ctx }: { ctx: string }) {
  const { data, isLoading, error } = useOverview(ctx);
  const { data: nodeMetrics } = useNodeMetrics(ctx);
  // Slow-warmup sections (all-secrets watcher, operator CR lists, API-server
  // TLS probe) arrive on their own; the core stats never wait for them.
  const { data: operators } = useOverviewOperators(ctx);
  const { data: certificates } = useOverviewCertificates(ctx);
  const multiCluster = useClustersStore((s) => s.selected.length > 1);
  const navigate = useNavigate();

  return (
    <>
      {isLoading && <OverviewSkeleton />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {data && (
        <Stack spacing={2}>
          <Box>
            <OverviewLabel>Needs attention</OverviewLabel>
            <AttentionTiles
              pending={!certificates || !operators}
              healthyText="No failing pods, unhealthy workloads, warnings in the last hour or expiring certificates."
              items={attentionItems({
                failingPods: data.failingPods,
                issues: data.unavailableWorkloads,
                warningEvents: data.warningEvents,
                certificates,
                operators,
                openPods: () => void navigate(unhealthyListPath({ group: '', version: 'v1', plural: 'pods' }, ctx, multiCluster)),
                openEvents: () => void navigate('/events'),
              })}
            />
          </Box>

          <ClusterInventory ctx={ctx} data={data} nodeMetrics={nodeMetrics} />

          {data.counts.nodes > 1 && <NodeUsageCard nodeMetrics={nodeMetrics} />}

          <WorkloadHealthSection ctx={ctx} health={data.workloadHealth} issues={data.unavailableWorkloads} />

          {operators && <OperatorSection ctx={ctx} operators={operators} />}

          {certificates && <CertExpiryCard ctx={ctx} certificates={certificates} />}

          <PodUsagePanels ctx={ctx} />

          <FailingPodsCard ctx={ctx} pods={data.failingPods} />

          {data.recentRestarts.length > 0 && (
            <ProblemCard title="Recent restarts (1h)" count={data.recentRestarts.length}>
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                {data.recentRestarts.slice(0, 20).map((r) => (
                  <Chip
                    key={`${r.namespace}/${r.pod}/${r.container}`}
                    label={`${r.namespace}/${r.pod} ×${r.restarts}${r.reason ? ` (${r.reason})` : ''}`}
                    variant="outlined"
                    color="warning"
                  />
                ))}
              </Stack>
            </ProblemCard>
          )}

          <WarningEventsCard ctx={ctx} events={data.warningEvents} />
        </Stack>
      )}
    </>
  );
}

/** Content-shaped placeholders matching the attention row and inventory. */
function OverviewSkeleton() {
  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 1 }}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} variant="rounded" height={78} />
        ))}
      </Box>
      <Stack direction="row" spacing={0.75}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} variant="rounded" width={120} height={34} />
        ))}
      </Stack>
      <Skeleton variant="rounded" height={160} />
    </Stack>
  );
}

/** Per-node CPU and memory, for clusters with more than one node (the inventory line carries the total). */
function NodeUsageCard({ nodeMetrics }: { nodeMetrics: NodeMetrics }) {
  if (!nodeMetrics?.available || nodeMetrics.items.length === 0) return null;
  return (
    <ProblemCard title="Node usage" count={nodeMetrics.items.length}>
      <Stack spacing={1}>
        {nodeMetrics.items.map((n) => (
          <Box key={n.name} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography variant="body2" sx={{ width: 220, maxWidth: '100%' }} noWrap title={n.name}>
              {n.name}
            </Typography>
            <UsageBar
              label={`CPU ${formatCpu(n.cpuMilli)}${n.cpuCapacityMilli ? ` / ${formatCpu(n.cpuCapacityMilli)}` : ''}`}
              pct={n.cpuCapacityMilli ? (n.cpuMilli / n.cpuCapacityMilli) * 100 : undefined}
            />
            <UsageBar
              label={`Mem ${formatBytes(n.memBytes)}${n.memCapacityBytes ? ` / ${formatBytes(n.memCapacityBytes)}` : ''}`}
              pct={n.memCapacityBytes ? (n.memBytes / n.memCapacityBytes) * 100 : undefined}
            />
          </Box>
        ))}
      </Stack>
    </ProblemCard>
  );
}

function UsageBar({ label, pct }: { label: string; pct?: number }) {
  return (
    <Box sx={{ flex: 1, minWidth: 220, display: 'flex', alignItems: 'center', gap: 1 }}>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, pct ?? 0)}
        color={(pct ?? 0) > 90 ? 'error' : (pct ?? 0) > 75 ? 'warning' : 'primary'}
        sx={{ flex: 1, height: 6, borderRadius: 3 }}
      />
      <Typography variant="caption" sx={{ width: 200, flexShrink: 0 }} color="text.secondary" noWrap>
        {label}
        {pct !== undefined ? ` (${pct.toFixed(0)}%)` : ''}
      </Typography>
    </Box>
  );
}
