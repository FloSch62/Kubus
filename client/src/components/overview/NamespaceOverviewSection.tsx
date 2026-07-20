import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import LinearProgress from '@mui/material/LinearProgress';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import { pluralLabel, type NamespaceInventoryEntry, type NamespaceQuotaStatus } from '@kubus/shared';
import { useNamespaceOverview } from '../../api/queries.js';
import { StatusChip } from '../StatusChip.js';
import { usageColor } from '../UsageMeter.js';
import { CertExpiryCard } from './CertExpiryCard.js';
import { FailingPodsCard, ProblemCard, WarningEventsCard, kindListPath } from './cards.js';
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
  const { data, isLoading, error } = useNamespaceOverview(ctx, namespaces);
  const single = namespaces.length === 1;
  // The success alert must agree with every problem card above it.
  const healthy =
    !!data &&
    data.issues.length === 0 &&
    data.failingPods.length === 0 &&
    data.warningEvents.length === 0 &&
    data.certificates.expiring.length === 0 &&
    data.operators.every((op) => op.resources.every((r) => r.issues.length === 0 && r.ready >= r.total));

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

          <OperatorSection ctx={ctx} operators={data.operators} scoped />

          <CertExpiryCard ctx={ctx} certificates={data.certificates} hideNamespace={single} />

          {data.quotas.length > 0 && <QuotasCard quotas={data.quotas} />}

          <PodUsagePanels ctx={ctx} namespaces={namespaces} />

          <FailingPodsCard ctx={ctx} pods={data.failingPods} hideNamespace={single} />

          <WarningEventsCard events={data.warningEvents} />

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
  const builtin = inventory.filter((e) => !e.custom);
  const custom = inventory.filter((e) => e.custom);
  return (
    <ProblemCard title="Inventory">
      <InventoryTiles entries={builtin} onOpen={(e) => navigate(kindListPath(e))} />
      {custom.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25, mb: 0.5 }}>
            Custom resources
          </Typography>
          <InventoryTiles entries={custom} onOpen={(e) => navigate(kindListPath(e))} />
        </>
      )}
    </ProblemCard>
  );
}

function InventoryTiles({ entries, onOpen }: { entries: NamespaceInventoryEntry[]; onOpen: (e: NamespaceInventoryEntry) => void }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {entries.map((e) => {
        const warn = (e.unhealthy ?? 0) > 0;
        return (
          <ButtonBase
            key={`${e.group}/${e.plural}`}
            onClick={() => onOpen(e)}
            title={e.group ? `${e.group}/${e.version}` : e.version}
            sx={{
              px: 1.25,
              py: 0.75,
              border: 1,
              borderColor: warn ? 'warning.main' : 'divider',
              borderRadius: 1.5,
              display: 'flex',
              alignItems: 'baseline',
              gap: 0.75,
              opacity: e.total === 0 && !warn ? 0.65 : 1,
              '&:hover': { bgcolor: 'action.hover', borderColor: warn ? 'warning.main' : 'primary.main', opacity: 1 },
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {pluralLabel(e.kind)}
            </Typography>
            {e.unavailable ? (
              <Typography variant="body2" color="text.disabled" title="Resource API unavailable on this cluster">
                —
              </Typography>
            ) : (
              <>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {e.total}
                </Typography>
                {warn && (
                  <Typography variant="body2" sx={{ fontWeight: 700, color: 'warning.main' }}>
                    {e.unhealthy} unhealthy
                  </Typography>
                )}
              </>
            )}
          </ButtonBase>
        );
      })}
    </Box>
  );
}

function QuotasCard({ quotas }: { quotas: NamespaceQuotaStatus[] }) {
  return (
    <ProblemCard title="Resource quotas">
      <Stack spacing={1.5}>
        {quotas.map((q) => (
          <Box key={q.name}>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
              {q.name}
            </Typography>
            <Stack spacing={0.5}>
              {q.resources.map((r) => (
                <Box key={r.resource} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography variant="caption" sx={{ width: 220, flexShrink: 0 }} noWrap title={r.resource}>
                    {r.resource}
                  </Typography>
                  {r.pct !== undefined ? (
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, r.pct)}
                      color={usageColor(r.pct)}
                      sx={{ flex: 1, height: 6, borderRadius: 3 }}
                    />
                  ) : (
                    <Box sx={{ flex: 1 }} />
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ width: 150, textAlign: 'right' }} noWrap>
                    {r.used} / {r.hard}
                    {r.pct !== undefined ? ` (${r.pct.toFixed(0)}%)` : ''}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </ProblemCard>
  );
}
