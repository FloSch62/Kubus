import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import { pluralLabel, type InventoryProblem, type NamespaceInventoryEntry, type NamespaceQuotaStatus, type OperatorRollup, type OverviewWorkloadIssue } from '@kubus/shared';
import { useNamespaceOverview, useOverviewCertificates, useOverviewOperators } from '../../api/queries.js';
import { useClustersStore } from '../../state/clusters.js';
import { StatusChip } from '../StatusChip.js';
import { AttentionTiles, OverviewLabel } from './Attention.js';
import { attentionItems } from './attention-items.js';
import { CertExpiryCard } from './CertExpiryCard.js';
import { FailingPodsCard, ProblemCard, WarningEventsCard, kindListPath } from './cards.js';
import { InventoryGrid, QuotaUsageList } from './InventoryGrid.js';
import { OperatorSection } from './OperatorSection.js';
import { PodUsagePanels } from './PodUsagePanels.js';
import { WorkloadHealthSection, unhealthyListPath } from './WorkloadHealthSection.js';

/** Kinds the server's workload-health checkers cover (their problems show as unhealthy workloads). */
const HEALTH_KIND_NAMES = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler', 'PersistentVolumeClaim', 'PodDisruptionBudget', 'ResourceQuota'];

/**
 * The overview body while the global namespace filter is active, in the
 * same shape as the cluster view: what needs attention first, then a
 * `kubectl get all -n`-style inventory (builtins + installed popular CRDs),
 * the unhealthy workloads with their causes, operator rollups, quotas, pod
 * usage, failing pods and warning events, all scoped to the selected
 * namespaces. List links inherit the same global filter.
 */
export function NamespaceOverviewSection({ ctx, namespaces }: { ctx: string; namespaces: string[] }) {
  const { data, isLoading, error, isPlaceholderData } = useNamespaceOverview(ctx, namespaces);
  // Operator rollups and certificates warm up slowly (operator CR lists, the
  // all-secrets watcher) — they stream in behind the inventory and health.
  const { data: operators } = useOverviewOperators(ctx, namespaces);
  const { data: certificates } = useOverviewCertificates(ctx, namespaces);
  const multiCluster = useClustersStore((s) => s.selected.length > 1);
  const navigate = useNavigate();
  const single = namespaces.length === 1;

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          Scoped to {single ? 'namespace' : 'namespaces'}{' '}
          <Typography component="span" variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>
            {namespaces.join(', ')}
          </Typography>
        </Typography>
        {data?.status && <StatusChip status={data.status} />}
      </Stack>

      {isLoading && !data && (
        <Stack spacing={1.5}>
          <Skeleton variant="rounded" height={78} />
          <Skeleton variant="rounded" height={110} />
        </Stack>
      )}
      {error && <Alert severity="error">{error.message}</Alert>}

      {data && (
        <Stack spacing={2}>
          <Box>
            <OverviewLabel>Needs attention</OverviewLabel>
            <AttentionTiles
              // Never judge a stale previous-scope placeholder against fresh operators/certs.
              pending={isPlaceholderData || !certificates || !operators}
              healthyText={`No failing pods, unhealthy workloads, warnings in the last hour or expiring certificates in ${single ? 'this namespace' : 'these namespaces'}.`}
              unchecked={[
                ...data.inventory.filter((e) => e.unavailable).map((e) => pluralLabel(e.kind)),
                ...(certificates?.secretsUnavailable ? ['TLS Secrets'] : []),
              ]}
              items={attentionItems({
                failingPods: data.failingPods,
                issues: data.issues,
                warningEvents: data.warningEvents,
                certificates,
                operators,
                otherProblems: otherProblems(data.problems, data.issues, operators),
                openPods: () => void navigate(unhealthyListPath({ group: '', version: 'v1', plural: 'pods' }, ctx, multiCluster)),
                openEvents: () => void navigate('/events'),
              })}
            />
          </Box>

          <InventoryCard inventory={data.inventory} />

          <WorkloadHealthSection ctx={ctx} health={data.workloadHealth} issues={data.issues} hideNamespace={single} />

          {operators && <OperatorSection ctx={ctx} operators={operators} scoped />}

          {certificates && <CertExpiryCard ctx={ctx} certificates={certificates} hideNamespace={single} />}

          {data.quotas.length > 0 && <QuotasCard ctx={ctx} namespaces={namespaces} quotas={data.quotas} />}

          <PodUsagePanels ctx={ctx} namespaces={namespaces} />

          <FailingPodsCard ctx={ctx} pods={data.failingPods} hideNamespace={single} />

          <WarningEventsCard ctx={ctx} events={data.warningEvents} />
        </Stack>
      )}
    </>
  );
}

/**
 * Inventory problems the other tiles don't already count: not pods (failing
 * pods), not the checked workload kinds (unhealthy workloads) and not custom
 * resources an operator rollup covers.
 */
function otherProblems(problems: InventoryProblem[], issues: OverviewWorkloadIssue[], operators: OperatorRollup[] | undefined): InventoryProblem[] {
  const covered = new Set(['Pod', ...HEALTH_KIND_NAMES, ...issues.map((i) => i.kind)]);
  const operatorKinds = new Set((operators ?? []).flatMap((op) => op.resources.map((r) => `${r.group}/${r.plural}`)));
  // A ReplicaSet short of replicas is its Deployment's problem, already listed.
  const deployments = issues.filter((i) => i.kind === 'Deployment');
  const ownedByListed = (p: InventoryProblem) =>
    p.kind === 'ReplicaSet' && deployments.some((d) => d.namespace === p.namespace && p.name.startsWith(`${d.name}-`));
  return problems.filter((p) => !covered.has(p.kind) && !operatorKinds.has(`${p.group}/${p.plural}`) && !ownedByListed(p));
}

function InventoryCard({ inventory }: { inventory: NamespaceInventoryEntry[] }) {
  const navigate = useNavigate();
  return (
    <Box data-anchor="inventory">
      <OverviewLabel>Inventory</OverviewLabel>
      <InventoryGrid inventory={inventory} onOpen={(e) => navigate(kindListPath(e))} />
    </Box>
  );
}

function QuotasCard({ ctx, namespaces, quotas }: { ctx: string; namespaces: string[]; quotas: NamespaceQuotaStatus[] }) {
  const navigate = useNavigate();
  // Multi-namespace scopes prefix the quota name with its namespace.
  const open = (q: NamespaceQuotaStatus) => {
    const slash = q.name.indexOf('/');
    const namespace = slash === -1 ? namespaces[0] : q.name.slice(0, slash);
    const name = slash === -1 ? q.name : q.name.slice(slash + 1);
    void navigate(kindListPath({ group: '', version: 'v1', plural: 'resourcequotas' }, { sel: { ctx, namespace, name } }));
  };
  return (
    <ProblemCard title="Resource quotas" count={quotas.length}>
      <QuotaUsageList quotas={quotas} onOpen={open} />
    </ProblemCard>
  );
}
