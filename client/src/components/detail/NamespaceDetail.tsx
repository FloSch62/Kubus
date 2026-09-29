import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { InventoryProblem, KubeObject } from '@kubus/shared';
import { useNamespaceOverview } from '../../api/queries.js';
import { openNamespaceList } from '../../namespace-link.js';
import { useDetailStore } from '../../state/detail.js';
import type { ResourceSelection } from '../ResourceDetailDrawer.js';
import { InventoryGrid, QuotaUsageList } from '../overview/InventoryGrid.js';
import { StatusChip } from '../StatusChip.js';
import { usageColor } from '../UsageMeter.js';
import { ClampedText } from './ClampedText.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';

/** Problem rows listed before the rest waits behind "Show more". */
const MAX_PROBLEMS = 20;

/**
 * The summary tone for a namespace's problems, from the same grades as the
 * inventory bars: any failed object is an error, degraded ones a warning.
 */
export function problemsTone(problems: InventoryProblem[]): 'error' | 'warning' | 'success' {
  if (problems.some((p) => p.grade === 'failed')) return 'error';
  return problems.length ? 'warning' : 'success';
}

function problemSelection(ctx: string, p: InventoryProblem): ResourceSelection {
  return { ctx, group: p.group, version: p.version, plural: p.plural, kind: p.kind, name: p.name, namespace: p.namespace || undefined, custom: p.custom };
}

function problemDetail(p: InventoryProblem): string | undefined {
  if (p.desired !== undefined) return `${p.ready ?? 0}/${p.desired} ready`;
  if (p.restarts) return `${p.restarts} restarts`;
  return undefined;
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
  const push = useDetailStore((s) => s.push);
  const guard = useDetailStore((s) => s.guard);
  const [showAll, setShowAll] = useState(false);
  const phase = (obj.status as { phase?: string } | undefined)?.phase;

  const pods = data?.inventory.find((e) => e.kind === 'Pod' && !e.custom);
  const problems = data?.problems ?? [];
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
            tone: problemsTone(problems),
            hint: 'Objects counted as degraded or failed in the inventory bars below.',
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
            {(showAll ? problems : problems.slice(0, MAX_PROBLEMS)).map((p) => (
              <ProblemRowView key={`${p.group}/${p.kind}/${p.namespace}/${p.name}`} problem={p} onOpen={() => push(problemSelection(ctx, p))} />
            ))}
            {!showAll && problems.length > MAX_PROBLEMS && (
              <Box sx={{ px: 1.5, py: 1 }}>
                <Link component="button" variant="body2" underline="hover" onClick={() => setShowAll(true)}>
                  Show {problems.length - MAX_PROBLEMS} more
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

function ProblemRowView({ problem, onOpen }: { problem: InventoryProblem; onOpen: () => void }) {
  const detail = problemDetail(problem);
  return (
    <Box sx={{ px: 1.5, py: 1, minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <Link component="button" variant="body2" underline="hover" onClick={onOpen} sx={{ fontWeight: 600, textAlign: 'left', overflowWrap: 'anywhere' }}>
          {problem.kind} {problem.name}
        </Link>
        {/* Colored by grade, like the bar segment it stands for; the reason is the text. */}
        <StatusChip status={problem.grade === 'failed' ? 'Failed' : 'Warning'} label={problem.reason} />
        {detail && (
          <Typography variant="caption" color="text.secondary">
            {detail}
          </Typography>
        )}
      </Stack>
      {problem.message && <ClampedText text={problem.message} lines={2} sx={{ mt: 0.25, color: 'text.secondary' }} />}
    </Box>
  );
}
