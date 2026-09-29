import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { gvkForKind, type InventoryHealth, type KubeObject, type NamespaceInventoryEntry, type NamespaceOverview, type OperatorRollup } from '@kubus/shared';
import { useNamespaceOverview, useOverviewOperators } from '../../api/queries.js';
import { openNamespaceList, openNamespaceOverview } from '../../namespace-link.js';
import { useDetailStore } from '../../state/detail.js';
import type { ResourceSelection } from '../ResourceDetailDrawer.js';
import { InventoryGrid, QuotaUsageList } from '../overview/InventoryGrid.js';
import { StatusChip } from '../StatusChip.js';
import { usageColor } from '../UsageMeter.js';
import { ClampedText } from './ClampedText.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';

/** Problem rows listed before the section points at the scoped overview for the rest. */
const MAX_PROBLEMS = 20;

interface ProblemRow {
  key: string;
  title: string;
  reason: string;
  detail?: string;
  message?: string;
  selection?: ResourceSelection;
}

function sumHealth(entries: NamespaceInventoryEntry[]): InventoryHealth {
  const total: InventoryHealth = { healthy: 0, degraded: 0, failed: 0 };
  for (const e of entries) {
    if (!e.health) continue;
    total.healthy += e.health.healthy;
    total.degraded += e.health.degraded;
    total.failed += e.health.failed;
  }
  return total;
}

/**
 * Workload-health issues first (the root causes), then failing pods, then
 * not-ready operator resources, each opening its object in the drawer.
 */
export function namespaceProblems(ctx: string, data: NamespaceOverview, operators: OperatorRollup[] | undefined): ProblemRow[] {
  const issues = data.issues.map((i): ProblemRow => {
    const gvk = gvkForKind(i.kind);
    return {
      key: `${i.kind}/${i.name}`,
      title: `${i.kind} ${i.name}`,
      reason: i.reason ?? 'Unhealthy',
      detail: i.desired !== undefined ? `${i.ready ?? 0}/${i.desired} ready` : undefined,
      message: i.message,
      selection: gvk && { ctx, group: gvk.group, version: gvk.version, plural: gvk.plural, kind: i.kind, name: i.name, namespace: i.namespace },
    };
  });
  const pods = data.failingPods.map(
    (p): ProblemRow => ({
      key: `Pod/${p.name}`,
      title: `Pod ${p.name}`,
      reason: p.reason,
      detail: p.restarts ? `${p.restarts} restarts` : undefined,
      message: p.message,
      selection: { ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: p.name, namespace: p.namespace },
    }),
  );
  const custom = (operators ?? []).flatMap((op) =>
    op.resources.flatMap((r) =>
      r.issues.map(
        (i): ProblemRow => ({
          key: `${r.group}/${r.kind}/${i.name}`,
          title: `${r.kind} ${i.name}`,
          reason: i.reason ?? 'NotReady',
          message: i.message,
          selection: { ctx, group: r.group, version: r.version, plural: r.plural, kind: r.kind, name: i.name, namespace: i.namespace, custom: true },
        }),
      ),
    ),
  );
  return [...issues, ...pods, ...custom];
}

/**
 * What lives in a namespace: the scoped overview's inventory with health
 * bars, the problems behind them and quota usage, above the usual metadata.
 * Inventory entries open their list narrowed to this namespace through the
 * global per-cluster filter, the same way the scoped Overview page links.
 */
export function NamespaceDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const name = obj.metadata.name;
  const namespaces = useMemo(() => [name], [name]);
  const { data, isLoading, error } = useNamespaceOverview(ctx, namespaces);
  const { data: operators } = useOverviewOperators(ctx, namespaces);
  const push = useDetailStore((s) => s.push);
  const guard = useDetailStore((s) => s.guard);
  const phase = (obj.status as { phase?: string } | undefined)?.phase;

  const pods = data?.inventory.find((e) => e.kind === 'Pod' && !e.custom);
  const health = data ? sumHealth(data.inventory) : undefined;
  const problems = data ? namespaceProblems(ctx, data, operators) : [];
  const worstQuota = data?.quotas.flatMap((q) => q.resources).reduce<number | undefined>((max, r) => (r.pct === undefined ? max : Math.max(max ?? 0, r.pct)), undefined);
  const kindsInUse = data?.inventory.filter((e) => e.total > 0).length;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Status', value: phase ?? '—', tone: phase === 'Active' ? 'success' : phase ? 'warning' : undefined },
          data && {
            label: 'Healthy pods',
            value: pods?.health ? `${pods.health.healthy} / ${pods.total}` : String(pods?.total ?? 0),
            tone: pods?.health ? (pods.health.failed ? 'error' : pods.health.degraded ? 'warning' : 'success') : undefined,
            hint: 'Running and ready, or completed, out of all pods in the namespace.',
          },
          data && {
            label: 'Problems',
            value: String(problems.length),
            tone: problems.length ? (health?.failed ? 'error' : 'warning') : 'success',
            hint: 'Unhealthy workloads, claims, budgets and quotas, failing pods and not-ready operator resources.',
          },
          data && { label: 'Kinds in use', value: String(kindsInUse ?? 0), hint: 'Kinds in the inventory with at least one object here.' },
          worstQuota !== undefined && { label: 'Quota use', value: `${worstQuota.toFixed(0)}%`, tone: usageColor(worstQuota), hint: 'The most used resource across the namespace quotas.' },
        ]}
      />
      {error && <Alert severity="error">{error.message}</Alert>}
      <Section title="Inventory" count={kindsInUse}>
        {data ? (
          <InventoryGrid inventory={data.inventory} onOpen={(e) => guard(() => openNamespaceList(ctx, name, e))} />
        ) : isLoading ? (
          <Skeleton variant="rounded" height={96} />
        ) : null}
      </Section>
      {problems.length > 0 && (
        <Section title="Problems" count={problems.length} flush>
          <Stack divider={<Divider />}>
            {problems.slice(0, MAX_PROBLEMS).map((p) => {
              const selection = p.selection;
              return <ProblemRowView key={p.key} row={p} onOpen={selection ? () => push(selection) : undefined} />;
            })}
            {problems.length > MAX_PROBLEMS && (
              <Box sx={{ px: 1.5, py: 1 }}>
                <Link component="button" variant="body2" underline="hover" onClick={() => guard(() => openNamespaceOverview(ctx, name))}>
                  {problems.length - MAX_PROBLEMS} more on the namespace overview
                </Link>
              </Box>
            )}
          </Stack>
        </Section>
      )}
      {data && data.quotas.length > 0 && (
        <Section title="Resource quotas" count={data.quotas.length}>
          <QuotaUsageList
            quotas={data.quotas}
            onOpen={(q) => push({ ctx, group: '', version: 'v1', plural: 'resourcequotas', kind: 'ResourceQuota', name: q.name, namespace: name })}
          />
        </Section>
      )}
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <ConditionsTable obj={obj} />
    </DetailStack>
  );
}

function ProblemRowView({ row, onOpen }: { row: ProblemRow; onOpen?: () => void }) {
  return (
    <Box sx={{ px: 1.5, py: 1, minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        {onOpen ? (
          <Link component="button" variant="body2" underline="hover" onClick={onOpen} sx={{ fontWeight: 600, textAlign: 'left', overflowWrap: 'anywhere' }}>
            {row.title}
          </Link>
        ) : (
          <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {row.title}
          </Typography>
        )}
        <StatusChip status={row.reason} />
        {row.detail && (
          <Typography variant="caption" color="text.secondary">
            {row.detail}
          </Typography>
        )}
      </Stack>
      {row.message && <ClampedText text={row.message} lines={2} sx={{ mt: 0.25, color: 'text.secondary' }} />}
    </Box>
  );
}
