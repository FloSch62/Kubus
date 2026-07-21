import { lazy, Suspense, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router';
import { useContexts, useKubeconfigSettings, useNodeMetrics, useOverview, useOverviewCertificates, useOverviewOperators } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { ClusterSectionHeader } from '../components/ClusterSectionHeader.js';
import { InstallMetricsServerButton } from '../components/MetricsServerControls.js';
import { formatBytes, formatCpu } from '../components/format.js';
import { CertExpiryCard } from '../components/overview/CertExpiryCard.js';
import { FailingPodsCard, ProblemCard, StatCard, WarningEventsCard } from '../components/overview/cards.js';
import { NamespaceOverviewSection } from '../components/overview/NamespaceOverviewSection.js';
import { OperatorSection } from '../components/overview/OperatorSection.js';
import { PodUsagePanels } from '../components/overview/PodUsagePanels.js';
import { WorkloadHealthSection } from '../components/overview/WorkloadHealthSection.js';

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
    <Stack spacing={3} sx={{ p: 2 }}>
      {selected.map((ctx) => (
        <ClusterOverviewSection key={ctx} ctx={ctx} />
      ))}
    </Stack>
  );
}

function ClusterOverviewSection({ ctx }: { ctx: string }) {
  // The global namespace filter scopes the whole overview: with namespaces
  // selected in the nav this section becomes the namespace-level view.
  const namespaces = useClustersStore((s) => s.namespaces);

  return (
    <Box>
      <ClusterSectionHeader ctx={ctx} />
      {namespaces.length > 0 ? <NamespaceOverviewSection ctx={ctx} namespaces={namespaces} /> : <WholeClusterSection ctx={ctx} />}
    </Box>
  );
}

function WholeClusterSection({ ctx }: { ctx: string }) {
  const { data, isLoading, error } = useOverview(ctx);
  const { data: nodeMetrics } = useNodeMetrics(ctx);
  // Slow-warmup sections (all-secrets watcher, operator CR lists, API-server
  // TLS probe) arrive on their own; the core stats never wait for them.
  const { data: operators } = useOverviewOperators(ctx);
  const { data: certificates } = useOverviewCertificates(ctx);
  const navigate = useNavigate();

  return (
    <>
      {isLoading && <OverviewSkeleton />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {data && (
        <>
          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            <StatCard label="Nodes" value={data.counts.nodes} icon={<DnsOutlinedIcon />} onClick={() => navigate('/r/core/v1/nodes')} />
            <StatCard label="Namespaces" value={data.counts.namespaces} icon={<WorkspacesOutlinedIcon />} onClick={() => navigate('/r/core/v1/namespaces')} />
            <StatCard
              label="Pods"
              value={`${data.counts.podsRunning}/${data.counts.pods}`}
              sub="running"
              warn={data.counts.podsRunning < data.counts.pods}
              icon={<ViewInArOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/pods')}
            />
            <StatCard label="Deployments" value={data.counts.deployments} icon={<RocketLaunchOutlinedIcon />} onClick={() => navigate('/r/apps/v1/deployments')} />
            <StatCard
              label="Persistent Volumes"
              value={data.counts.persistentVolumesUnavailable ? '-' : data.counts.persistentVolumesBound}
              sub={
                data.counts.persistentVolumesUnavailable
                  ? 'unavailable'
                  : data.counts.persistentVolumes === data.counts.persistentVolumesBound
                    ? 'bound'
                    : `of ${data.counts.persistentVolumes} bound`
              }
              warn={!data.counts.persistentVolumesUnavailable && data.counts.persistentVolumesBound < data.counts.persistentVolumes}
              icon={<StorageOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/persistentvolumes')}
            />
            <StatCard
              label="CRDs"
              value={data.counts.crdsUnavailable ? '-' : data.counts.crdsEstablished}
              sub={data.counts.crdsUnavailable ? 'unavailable' : data.counts.crds === data.counts.crdsEstablished ? 'active' : `of ${data.counts.crds} active`}
              warn={!data.counts.crdsUnavailable && data.counts.crdsEstablished < data.counts.crds}
              icon={<ExtensionOutlinedIcon />}
              onClick={() => navigate('/r/apiextensions.k8s.io/v1/customresourcedefinitions')}
            />
            <StatCard
              label="Custom Resources"
              value={data.counts.customResources}
              sub={data.counts.customResourcesIndexed ? 'instances' : 'indexing'}
              icon={<Inventory2OutlinedIcon />}
            />
            <StatCard
              label="TLS certificates"
              value={certificates ? (certificates.expiring.length > 0 ? certificates.expiring.length : certificates.total) : <Skeleton width={32} />}
              sub={certificates ? (certificates.expiring.length > 0 ? 'expiring <30d' : 'tracked') : undefined}
              warn={(certificates?.expiring.length ?? 0) > 0}
              icon={<VerifiedUserOutlinedIcon />}
              onClick={() => {
                const certs = operators?.find((o) => o.id === 'cert-manager')?.resources.find((r) => r.plural === 'certificates');
                void navigate(certs ? `/r/${certs.group}/${certs.version}/${certs.plural}` : '/r/core/v1/secrets');
              }}
            />
            <StatCard
              label="Failing pods"
              value={data.failingPods.length}
              warn={data.failingPods.length > 0}
              icon={<ErrorOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/pods')}
            />
            <StatCard
              label="Warnings (1h)"
              value={data.warningEvents.length}
              warn={data.warningEvents.length > 0}
              icon={<WarningAmberOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/events')}
            />
          </Grid>

          {data.counts.nodes > 0 && <NodeUsageCard ctx={ctx} nodeMetrics={nodeMetrics} />}

          <WorkloadHealthSection ctx={ctx} health={data.workloadHealth} issues={data.unavailableWorkloads} />

          {operators && <OperatorSection ctx={ctx} operators={operators} />}

          {certificates && <CertExpiryCard ctx={ctx} certificates={certificates} />}

          <PodUsagePanels ctx={ctx} />

          <FailingPodsCard ctx={ctx} pods={data.failingPods} />

          {data.recentRestarts.length > 0 && (
            <ProblemCard title="Recent restarts (1h)">
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                {data.recentRestarts.slice(0, 20).map((r) => (
                  <Chip key={`${r.namespace}/${r.pod}/${r.container}`} label={`${r.namespace}/${r.pod} ×${r.restarts}${r.reason ? ` (${r.reason})` : ''}`} variant="outlined" color="warning" />
                ))}
              </Stack>
            </ProblemCard>
          )}

          <WarningEventsCard ctx={ctx} events={data.warningEvents} />

          {data.failingPods.length === 0 &&
            data.unavailableWorkloads.length === 0 &&
            data.warningEvents.length === 0 &&
            certificates &&
            certificates.expiring.length === 0 &&
            operators &&
            operators.every((op) => op.resources.every((r) => r.issues.length === 0 && r.ready >= r.total)) && (
              <Alert severity="success" variant="outlined">
                No problems detected — all workloads healthy.
              </Alert>
            )}
        </>
      )}
    </>
  );
}

/** Content-shaped placeholders matching the stat-card grid and node-usage card. */
function OverviewSkeleton() {
  return (
    <>
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <Grid key={i} size={{ xs: 6, sm: 4, md: 3, lg: 2 }}>
            <Skeleton variant="rounded" height={62} />
          </Grid>
        ))}
      </Grid>
      <Skeleton variant="rounded" height={120} />
    </>
  );
}

function NodeUsageCard({ ctx, nodeMetrics }: { ctx: string; nodeMetrics: ReturnType<typeof useNodeMetrics>['data'] }) {
  const total = useMemo(() => {
    if (!nodeMetrics?.available || nodeMetrics.items.length === 0) return undefined;
    return nodeMetrics.items.reduce(
      (acc, item) => ({
        cpuMilli: acc.cpuMilli + item.cpuMilli,
        memBytes: acc.memBytes + item.memBytes,
        cpuCapacityMilli: acc.cpuCapacityMilli + (item.cpuCapacityMilli ?? 0),
        memCapacityBytes: acc.memCapacityBytes + (item.memCapacityBytes ?? 0),
      }),
      { cpuMilli: 0, memBytes: 0, cpuCapacityMilli: 0, memCapacityBytes: 0 },
    );
  }, [nodeMetrics]);

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Node usage
        </Typography>
        {/* Before the first poller probe completes, "unavailable" is provisional —
            keep the progress bar instead of a false install prompt. */}
        {(!nodeMetrics || !nodeMetrics.probed) && <LinearProgress />}
        {nodeMetrics?.probed && !nodeMetrics.available && (
          <Alert severity="info" variant="outlined" sx={{ alignItems: 'center' }} action={<InstallMetricsServerButton ctx={ctx} />}>
            CPU and memory usage are unavailable — metrics-server is not serving data in this cluster.
          </Alert>
        )}
        {nodeMetrics?.available && nodeMetrics.items.length === 0 && (
          <Alert severity="info" variant="outlined">
            Waiting for node metrics.
          </Alert>
        )}
        {nodeMetrics?.available && nodeMetrics.items.length > 0 && (
          <Stack spacing={1}>
            {total && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  pb: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Typography variant="body2" sx={{ width: 220, fontWeight: 600 }} noWrap>
                  Total
                </Typography>
                <UsageBar label={`CPU ${formatCpu(total.cpuMilli)}`} pct={total.cpuCapacityMilli > 0 ? (total.cpuMilli / total.cpuCapacityMilli) * 100 : undefined} />
                <UsageBar label={`Mem ${formatBytes(total.memBytes)}`} pct={total.memCapacityBytes > 0 ? (total.memBytes / total.memCapacityBytes) * 100 : undefined} />
              </Box>
            )}
            {nodeMetrics.items.map((n) => (
              <Box key={n.name} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Typography variant="body2" sx={{ width: 220 }} noWrap>
                  {n.name}
                </Typography>
                <UsageBar label={`CPU ${formatCpu(n.cpuMilli)}`} pct={n.cpuCapacityMilli ? (n.cpuMilli / n.cpuCapacityMilli) * 100 : undefined} />
                <UsageBar label={`Mem ${formatBytes(n.memBytes)}`} pct={n.memCapacityBytes ? (n.memBytes / n.memCapacityBytes) * 100 : undefined} />
              </Box>
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function UsageBar({ label, pct }: { label: string; pct?: number }) {
  return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, pct ?? 0)}
        color={(pct ?? 0) > 90 ? 'error' : (pct ?? 0) > 75 ? 'warning' : 'primary'}
        sx={{ flex: 1, height: 6, borderRadius: 3 }}
      />
      <Typography variant="caption" sx={{ width: 130 }} color="text.secondary">
        {label}
        {pct !== undefined ? ` (${pct.toFixed(0)}%)` : ''}
      </Typography>
    </Box>
  );
}
