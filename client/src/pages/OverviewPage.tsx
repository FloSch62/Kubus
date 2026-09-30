import { lazy, Suspense, useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router';
import { pluralLabel, type ClusterOverview, type OperatorRollup, type OverviewCertificates } from '@kubus/shared';
import { useContexts, useKubeconfigSettings, useNodeMetrics, useOverview, useOverviewCertificates, useOverviewOperators } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useOverviewPrefsStore } from '../state/overview-prefs.js';
import { ClusterSectionHeader } from '../components/ClusterSectionHeader.js';
import { PageHeader } from '../components/PageHeader.js';
import { AttentionTiles, InventoryButton, InventoryRow, OverviewLabel } from '../components/overview/Attention.js';
import { attentionItems } from '../components/overview/attention-items.js';
import { CertExpiryCard } from '../components/overview/CertExpiryCard.js';
import { ClusterSummaryBar } from '../components/overview/ClusterSummary.js';
import { FailingPodsCard, ProblemCard, WarningEventsCard, kindListPath } from '../components/overview/cards.js';
import { issueTone } from '../components/overview/issue-cause.js';
import { kindIcon } from '../components/overview/kind-icons.js';
import { NamespaceOverviewSection } from '../components/overview/NamespaceOverviewSection.js';
import { NodeUsageCard } from '../components/overview/NodeUsageCard.js';
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

  const multi = selected.length > 1;
  return (
    <Box sx={{ p: 2 }}>
      <PageHeader title="Overview" icon={<SpaceDashboardOutlinedIcon />} actions={multi ? <ExpandAllButton contexts={selected} /> : undefined}>
        {multi && (
          <Typography variant="body2" color="text.secondary">
            {selected.length} clusters
          </Typography>
        )}
      </PageHeader>
      {multi ? (
        <Stack spacing={1}>
          {selected.map((ctx) => (
            <CollapsibleClusterSection key={ctx} ctx={ctx} />
          ))}
        </Stack>
      ) : (
        <ClusterOverviewSection ctx={selected[0]!} />
      )}
    </Box>
  );
}

/** "Expand all" while any cluster shows only its summary, else "Collapse all". */
function ExpandAllButton({ contexts }: { contexts: string[] }) {
  const allExpanded = useOverviewPrefsStore((s) => contexts.every((ctx) => s.expanded[ctx]));
  const setAllExpanded = useOverviewPrefsStore((s) => s.setAllExpanded);
  return (
    <Button
      size="small"
      color="inherit"
      startIcon={allExpanded ? <UnfoldLessIcon /> : <UnfoldMoreIcon />}
      onClick={() => setAllExpanded(contexts, !allExpanded)}
      sx={{ color: 'text.secondary' }}
    >
      {allExpanded ? 'Collapse all' : 'Expand all'}
    </Button>
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

/**
 * A cluster on the multi-cluster Overview: a summary bar that opens the full
 * section. Clusters start as summaries so several fit on one screen; the ones
 * you open stay open.
 */
function CollapsibleClusterSection({ ctx }: { ctx: string }) {
  const namespaces = useClustersStore((s) => s.namespacesByContext[ctx] ?? EMPTY_NAMESPACES);
  const expanded = useOverviewPrefsStore((s) => !!s.expanded[ctx]);
  const setExpanded = useOverviewPrefsStore((s) => s.setExpanded);
  const bodyId = useId();

  return (
    <Box data-overview-section={ctx}>
      <ClusterSummaryBar ctx={ctx} namespaces={namespaces} expanded={expanded} onToggle={() => setExpanded(ctx, !expanded)} controls={bodyId} />
      {expanded && (
        <Box id={bodyId} sx={{ pt: 2, pb: 3 }}>
          {namespaces.length > 0 ? <NamespaceOverviewSection ctx={ctx} namespaces={namespaces} /> : <WholeClusterSection ctx={ctx} />}
        </Box>
      )}
    </Box>
  );
}

/** Short labels where the plural kind name would crowd the inventory row. */
const SHORT_LABEL: Record<string, string> = { HorizontalPodAutoscaler: 'HPAs', PersistentVolumeClaim: 'PVCs', PodDisruptionBudget: 'PDBs' };

const kindLabel = (kind: string) => SHORT_LABEL[kind] ?? pluralLabel(kind);

/** "Cluster" / "Workloads" in front of an inventory row, centred on the 34px buttons. */
function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ lineHeight: '34px', whiteSpace: 'nowrap' }}>
      {children}
    </Typography>
  );
}

/**
 * Cluster-scoped counts, then every checked workload, storage and policy
 * kind with its unhealthy count (open its list, narrowed to the broken ones
 * when there are some). Kinds that could not be read say so instead of
 * showing zero.
 */
function ClusterInventory({
  ctx,
  data,
  certificates,
  operators,
}: {
  ctx: string;
  data: ClusterOverview;
  certificates: OverviewCertificates | undefined;
  operators: OperatorRollup[] | undefined;
}) {
  const navigate = useNavigate();
  const multiCluster = useClustersStore((s) => s.selected.length > 1);
  const { counts } = data;
  const podsNotRunning = counts.pods - counts.podsRunning;
  const pvsUnbound = counts.persistentVolumes - counts.persistentVolumesBound;
  const crdsInactive = counts.crds - counts.crdsEstablished;
  return (
    <Box data-anchor="inventory">
      <OverviewLabel>Inventory</OverviewLabel>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 1.5, rowGap: 0.75, alignItems: 'start' }}>
        <RowLabel>Cluster</RowLabel>
        <InventoryRow>
          <InventoryButton icon={kindIcon('Node')} label="Nodes" value={counts.nodes} onClick={() => navigate('/r/core/v1/nodes')} />
          <InventoryButton icon={kindIcon('Namespace')} label="Namespaces" value={counts.namespaces} onClick={() => navigate('/r/core/v1/namespaces')} />
          <InventoryButton
            icon={kindIcon('PersistentVolume')}
            label="PVs"
            value={counts.persistentVolumesUnavailable ? undefined : counts.persistentVolumesBound}
            sub={counts.persistentVolumesUnavailable ? 'unavailable' : ' bound'}
            quiet={!counts.persistentVolumesUnavailable && counts.persistentVolumes === 0}
            problem={!counts.persistentVolumesUnavailable && pvsUnbound > 0 ? { text: `${pvsUnbound} not bound`, tone: 'warning' } : undefined}
            title={
              counts.persistentVolumesUnavailable
                ? 'Persistent volumes could not be listed: no access, or the API is not served'
                : `${counts.persistentVolumesBound} of ${counts.persistentVolumes} persistent volumes are bound`
            }
            ariaLabel={
              counts.persistentVolumesUnavailable
                ? 'PVs: unavailable'
                : `PVs: ${counts.persistentVolumesBound} of ${counts.persistentVolumes} bound`
            }
            onClick={() => navigate('/r/core/v1/persistentvolumes')}
          />
          <InventoryButton
            icon={kindIcon('CustomResourceDefinition')}
            label="CRDs"
            value={counts.crdsUnavailable ? undefined : counts.crdsEstablished}
            sub={counts.crdsUnavailable ? 'unavailable' : undefined}
            quiet={!counts.crdsUnavailable && counts.crds === 0}
            problem={!counts.crdsUnavailable && crdsInactive > 0 ? { text: `${crdsInactive} not established`, tone: 'warning' } : undefined}
            title={
              counts.crdsUnavailable
                ? 'Custom resource definitions could not be listed: no access, or the API is not served'
                : `${counts.crdsEstablished} of ${counts.crds} custom resource definitions are established`
            }
            ariaLabel={counts.crdsUnavailable ? 'CRDs: unavailable' : `CRDs: ${counts.crdsEstablished} of ${counts.crds} established`}
            onClick={() => navigate('/r/apiextensions.k8s.io/v1/customresourcedefinitions')}
          />
          <CertificatesButton certificates={certificates} operators={operators} />
        </InventoryRow>

        <RowLabel>Workloads</RowLabel>
        <InventoryRow>
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
          {data.workloadHealth.map((h) => {
            const plural = pluralLabel(h.kind);
            const tone = data.unavailableWorkloads.some((i) => i.kind === h.kind && issueTone(i) === 'error') ? 'error' : 'warning';
            return (
              <InventoryButton
                key={h.kind}
                icon={kindIcon(h.kind)}
                label={kindLabel(h.kind)}
                value={h.unavailable ? undefined : h.total}
                sub={h.unavailable ? 'no access' : undefined}
                quiet={!h.unavailable && h.total === 0}
                problem={!h.unavailable && h.unhealthy > 0 ? { text: `${h.unhealthy} unhealthy`, tone } : undefined}
                title={
                  h.unavailable
                    ? `${plural} could not be listed: no access, or the API is not served`
                    : h.unhealthy > 0
                      ? `${h.unhealthy} of ${h.total} ${plural} are unhealthy. Opens the unhealthy ones.`
                      : plural
                }
                ariaLabel={`${plural}: ${h.unavailable ? 'no access' : h.total}${!h.unavailable && h.unhealthy > 0 ? `, ${h.unhealthy} unhealthy` : ''}`}
                onClick={() => navigate(!h.unavailable && h.unhealthy > 0 ? unhealthyListPath(h, ctx, multiCluster) : kindListPath(h))}
              />
            );
          })}
        </InventoryRow>
      </Box>
    </Box>
  );
}

const API_SERVER_WARN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tracked TLS certificates (cert-manager Certificates plus kubernetes.io/tls
 * Secrets) with the expiring ones called out. Opens the cert-manager
 * Certificates list when cert-manager is installed, else the Secrets list.
 */
function CertificatesButton({ certificates, operators }: { certificates: OverviewCertificates | undefined; operators: OperatorRollup[] | undefined }) {
  const navigate = useNavigate();
  const now = Date.now();
  const apiServerSoon = !!certificates?.apiServerNotAfter && Date.parse(certificates.apiServerNotAfter) - now < API_SERVER_WARN_MS;
  const expiring = (certificates?.expiring.length ?? 0) + (apiServerSoon ? 1 : 0);
  const expired = !!certificates?.expiring.some((c) => Date.parse(c.notAfter) <= now);
  const certs = operators?.find((o) => o.id === 'cert-manager')?.resources.find((r) => r.plural === 'certificates');
  return (
    <InventoryButton
      icon={<VerifiedUserOutlinedIcon />}
      label="TLS certificates"
      value={certificates ? certificates.total : <Skeleton width={16} sx={{ display: 'inline-block' }} />}
      problem={expiring > 0 ? { text: `${expiring} expiring`, tone: expired ? 'error' : 'warning' } : undefined}
      quiet={certificates?.total === 0 && expiring === 0}
      title={
        certificates
          ? `${certificates.total} tracked: cert-manager Certificates and TLS Secrets${expiring ? `. ${expiring} expired or expiring within 30 days.` : ''}${certificates.secretsUnavailable ? ' TLS Secrets could not be read.' : ''}`
          : 'Checking certificates'
      }
      ariaLabel={certificates ? `TLS certificates: ${certificates.total} tracked${expiring ? `, ${expiring} expiring` : ''}` : 'TLS certificates: loading'}
      onClick={() => void navigate(certs ? kindListPath(certs) : '/r/core/v1/secrets')}
    />
  );
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
              unchecked={[
                ...data.workloadHealth.filter((h) => h.unavailable).map((h) => kindLabel(h.kind)),
                ...(certificates?.secretsUnavailable ? ['TLS Secrets'] : []),
              ]}
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

          <ClusterInventory ctx={ctx} data={data} certificates={certificates} operators={operators} />

          {data.counts.nodes > 0 && <NodeUsageCard ctx={ctx} nodes={data.counts.nodes} nodeMetrics={nodeMetrics} />}

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
