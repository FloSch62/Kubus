import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import type { NamespaceInventoryEntry, NamespaceQuotaStatus } from '@kubus/shared';
import { useNamespaceOverview, useOverviewCertificates, useOverviewOperators } from '../../api/queries.js';
import { StatusChip } from '../StatusChip.js';
import { CertExpiryCard } from './CertExpiryCard.js';
import { FailingPodsCard, ProblemCard, WarningEventsCard, kindListPath } from './cards.js';
import { InventoryGrid, QuotaUsageList } from './InventoryGrid.js';
import { OperatorSection } from './OperatorSection.js';
import { PodUsagePanels } from './PodUsagePanels.js';
import { WorkloadHealthSection } from './WorkloadHealthSection.js';

/**
 * The overview body while the global namespace filter is active: a
 * `kubectl get all -n`-style inventory (builtins + installed popular CRDs),
 * unified workload health, operator rollups, quota usage, pod usage panels,
 * failing pods and warning events — all scoped to the selected namespaces.
 * List links inherit the same global filter.
 */
export function NamespaceOverviewSection({ ctx, namespaces }: { ctx: string; namespaces: string[] }) {
  const { data, isLoading, error, isPlaceholderData } = useNamespaceOverview(ctx, namespaces);
  // Operator rollups and certificates warm up slowly (operator CR lists, the
  // all-secrets watcher) — they stream in behind the inventory and health.
  const { data: operators } = useOverviewOperators(ctx, namespaces);
  const { data: certificates } = useOverviewCertificates(ctx, namespaces);
  const single = namespaces.length === 1;
  // The success alert must agree with every problem card above it — and never
  // judge a stale previous-scope placeholder against fresh operators/certs.
  const healthy =
    !!data &&
    !isPlaceholderData &&
    data.issues.length === 0 &&
    data.failingPods.length === 0 &&
    data.warningEvents.length === 0 &&
    !!certificates &&
    certificates.expiring.length === 0 &&
    !!operators &&
    operators.every((op) => op.resources.every((r) => r.issues.length === 0 && r.ready >= r.total));

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
          <Skeleton variant="rounded" height={110} />
          <Skeleton variant="rounded" height={180} />
        </Stack>
      )}
      {error && <Alert severity="error">{error.message}</Alert>}

      {data && (
        <>
          <InventoryCard inventory={data.inventory} />

          <WorkloadHealthSection ctx={ctx} health={data.workloadHealth} issues={data.issues} scoped hideNamespace={single} />

          {operators && <OperatorSection ctx={ctx} operators={operators} scoped />}

          {certificates && <CertExpiryCard ctx={ctx} certificates={certificates} hideNamespace={single} />}

          {data.quotas.length > 0 && <QuotasCard ctx={ctx} namespaces={namespaces} quotas={data.quotas} />}

          <PodUsagePanels ctx={ctx} namespaces={namespaces} />

          <FailingPodsCard ctx={ctx} pods={data.failingPods} hideNamespace={single} />

          <WarningEventsCard ctx={ctx} events={data.warningEvents} />

          {healthy && (
            <Alert severity="success" variant="outlined">
              No problems detected in {single ? 'this namespace' : 'these namespaces'}.
            </Alert>
          )}
        </>
      )}
    </>
  );
}

function InventoryCard({ inventory }: { inventory: NamespaceInventoryEntry[] }) {
  const navigate = useNavigate();
  return (
    <ProblemCard title="Inventory">
      <InventoryGrid inventory={inventory} onOpen={(e) => navigate(kindListPath(e))} />
    </ProblemCard>
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
    <ProblemCard title="Resource quotas">
      <QuotaUsageList quotas={quotas} onOpen={open} />
    </ProblemCard>
  );
}
