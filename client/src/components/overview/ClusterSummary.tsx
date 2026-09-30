import { useMemo } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { pluralLabel, type ContextInfo } from '@kubus/shared';
import { useContexts, useNamespaceOverview, useNodeMetrics, useOverview, useOverviewCertificates } from '../../api/queries.js';
import { clusterColorIndexes, clusterTagColors } from '../../cluster-color.js';
import { useClustersStore } from '../../state/clusters.js';
import { statusTextColor } from '../../theme.js';
import { ContextHealthDot } from '../ContextHealthDot.js';
import type { AttentionItem } from './Attention.js';
import { attentionItems } from './attention-items.js';
import { clusterUsage } from './NodeUsageCard.js';

interface SummaryProps {
  ctx: string;
  /** The cluster's namespace filter: the summary then covers those namespaces. */
  namespaces: string[];
  expanded: boolean;
  onToggle: () => void;
  /** Id of the section body the bar opens. */
  controls: string;
}

/**
 * One cluster on the multi-cluster Overview as a single bar: the cluster,
 * its size and load, and what needs attention, as the heading that opens
 * the full section below it. The bar reads the same queries as the section
 * (overview, node metrics, certificates), so opening it costs nothing more;
 * operator rollups are only fetched once the section is open.
 */
export function ClusterSummaryBar(props: SummaryProps) {
  return props.namespaces.length > 0 ? <NamespaceSummaryBar {...props} /> : <WholeClusterSummaryBar {...props} />;
}

const noop = () => {};

function WholeClusterSummaryBar({ ctx, expanded, onToggle, controls }: SummaryProps) {
  const { data, isLoading, error } = useOverview(ctx);
  const { data: nodeMetrics } = useNodeMetrics(ctx);
  const { data: certificates } = useOverviewCertificates(ctx);
  const usage = useMemo(() => clusterUsage(nodeMetrics), [nodeMetrics]);
  const info = useContextInfo(ctx);

  const counts = data?.counts;
  const items = data
    ? attentionItems({ failingPods: data.failingPods, issues: data.unavailableWorkloads, warningEvents: data.warningEvents, certificates, openPods: noop, openEvents: noop })
    : [];
  const unchecked = data?.workloadHealth.filter((h) => h.unavailable).map((h) => pluralLabel(h.kind)) ?? [];
  // metrics-server missing or not probed yet: the meters say so instead of 0%.
  const metricsState = !nodeMetrics?.probed ? 'loading' : !nodeMetrics.available ? 'missing' : !usage ? 'waiting' : 'ok';

  return (
    <SummaryShell
      ctx={ctx}
      info={info}
      expanded={expanded}
      onToggle={onToggle}
      controls={controls}
      caption={
        counts
          ? [info?.kubernetesVersion, `${counts.nodes} ${counts.nodes === 1 ? 'node' : 'nodes'}`, `${counts.namespaces} namespaces`].filter(Boolean).join(' · ')
          : (info?.server ?? '')
      }
      error={unreachable(info, error)}
      loading={isLoading && !data}
      stats={
        counts && (
          <>
            <Stat label="Pods running" title={`${counts.podsRunning} of ${counts.pods} pods are running`}>
              {counts.podsRunning}
              <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                {` / ${counts.pods}`}
              </Box>
            </Stat>
            <UsageStat label="CPU" state={metricsState} pct={usage && usage.cpuCapacityMilli > 0 ? (usage.cpuMilli / usage.cpuCapacityMilli) * 100 : undefined} />
            <UsageStat label="Memory" state={metricsState} pct={usage && usage.memCapacityBytes > 0 ? (usage.memBytes / usage.memCapacityBytes) * 100 : undefined} />
          </>
        )
      }
      items={items}
      pending={!certificates}
      unchecked={unchecked}
    />
  );
}

function NamespaceSummaryBar({ ctx, namespaces, expanded, onToggle, controls }: SummaryProps) {
  const { data, isLoading, error } = useNamespaceOverview(ctx, namespaces);
  const { data: certificates } = useOverviewCertificates(ctx, namespaces);
  const info = useContextInfo(ctx);

  const pods = data?.inventory.find((e) => e.kind === 'Pod' && !e.custom);
  const deployments = data?.inventory.find((e) => e.kind === 'Deployment' && !e.custom);
  const items = data ? attentionItems({ failingPods: data.failingPods, issues: data.issues, warningEvents: data.warningEvents, certificates, openPods: noop, openEvents: noop }) : [];
  const scope = namespaces.length === 1 ? `Namespace ${namespaces[0]}` : `${namespaces.length} namespaces`;

  return (
    <SummaryShell
      ctx={ctx}
      info={info}
      expanded={expanded}
      onToggle={onToggle}
      controls={controls}
      caption={[scope, data?.status].filter(Boolean).join(' · ')}
      error={unreachable(info, error)}
      loading={isLoading && !data}
      stats={
        data && (
          <>
            <Stat label="Pods" title={pods?.health ? `${pods.health.healthy} of ${pods.total} pods are running or complete` : undefined}>
              {pods ? pods.total : '—'}
            </Stat>
            <Stat label="Deployments">{deployments ? deployments.total : '—'}</Stat>
          </>
        )
      }
      items={items}
      pending={!certificates}
      unchecked={data?.inventory.filter((e) => e.unavailable).map((e) => pluralLabel(e.kind)) ?? []}
    />
  );
}

/** Why the cluster can't be summarised: the connection check's words first, they read better than a failed request. */
function unreachable(info: ContextInfo | undefined, error: Error | null): string | undefined {
  if (info?.health === 'error') return info.healthMessage ?? error?.message ?? 'Connection failed';
  return error?.message;
}

function useContextInfo(ctx: string): ContextInfo | undefined {
  // Rides on the cluster picker's polling, like the section headers.
  const { data: contexts } = useContexts({ poll: false });
  return contexts?.find((c) => c.name === ctx);
}

/** Short pill text per attention tile: the overview's labels, shortened where they run long. */
function pillLabel(item: AttentionItem): string {
  if (item.key === 'warnings') return item.count === 1 ? 'warning (1h)' : 'warnings (1h)';
  if (item.key === 'certificates') return item.count === 1 ? 'certificate expiring' : 'certificates expiring';
  return item.label;
}

function SummaryShell({
  ctx,
  info,
  expanded,
  onToggle,
  controls,
  caption,
  error,
  loading,
  stats,
  items,
  pending,
  unchecked,
}: {
  ctx: string;
  info: ContextInfo | undefined;
  expanded: boolean;
  onToggle: () => void;
  controls: string;
  caption: string;
  error?: string;
  loading: boolean;
  stats: React.ReactNode;
  items: AttentionItem[];
  pending: boolean;
  unchecked: string[];
}) {
  const theme = useTheme();
  const colorIndex = useClustersStore((s) => clusterColorIndexes(s.selected).get(ctx) ?? 0);
  const { fg } = clusterTagColors(colorIndex, theme.palette.mode);
  const shown = items.filter((item) => item.count > 0);

  return (
    <Box component="h2" sx={{ m: 0, font: 'inherit' }}>
      <ButtonBase
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? controls : undefined}
        sx={(t) => ({
          width: '100%',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'flex-start',
          columnGap: 3,
          rowGap: 1.25,
          px: 1.5,
          py: 1.25,
          textAlign: 'left',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.5,
          bgcolor: 'background.paper',
          transition: 'background-color 120ms ease, border-color 120ms ease',
          '&:hover': {
            borderColor: alpha(t.palette.primary.main, 0.45),
            bgcolor: alpha(t.palette.primary.main, t.palette.mode === 'dark' ? 0.06 : 0.025),
          },
          '&:hover .summary-chevron': { color: 'primary.main' },
          '&.Mui-focusVisible': { outline: `2px solid ${t.palette.primary.main}`, outlineOffset: 2 },
        })}
      >
        <Box component="span" sx={{ flex: '0 1 280px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
          <ExpandMoreIcon
            className="summary-chevron"
            sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0, transition: 'transform 150ms ease, color 120ms ease', transform: expanded ? 'none' : 'rotate(-90deg)' }}
          />
          <Box component="span" aria-hidden sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: fg, flexShrink: 0 }} />
          <Box component="span" sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
              <Typography component="span" sx={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35 }} noWrap title={ctx}>
                {ctx}
              </Typography>
              <ContextHealthDot info={info} size={9} />
            </Box>
            {caption && (
              <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ lineHeight: 1.4 }}>
                {caption}
              </Typography>
            )}
          </Box>
        </Box>

        {error ? (
          <Box
            component="span"
            title={error}
            sx={(t) => ({
              flex: '1 1 260px',
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.25,
              py: 0.625,
              borderRadius: 1,
              bgcolor: alpha(t.palette.error.main, t.palette.mode === 'dark' ? 0.14 : 0.07),
            })}
          >
            <ErrorOutlineIcon sx={{ fontSize: 17, color: statusTextColor('error'), flexShrink: 0 }} />
            <Typography component="span" variant="body2" noWrap sx={{ minWidth: 0 }}>
              <Box component="span" sx={{ fontWeight: 650, color: statusTextColor('error') }}>
                Unreachable
              </Box>
              <Box component="span" sx={{ color: 'text.secondary' }}>{` · ${error}`}</Box>
            </Typography>
          </Box>
        ) : (
          <>
            <Box component="span" sx={{ display: 'flex', gap: 2.5, flexShrink: 0 }}>
              {loading ? (
                <>
                  <StatSkeleton />
                  <StatSkeleton />
                  <StatSkeleton />
                </>
              ) : (
                stats
              )}
            </Box>
            <Box component="span" sx={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.75 }}>
              {/* Open, the attention row right below says the same with detail. */}
              {expanded ? null : loading || (shown.length === 0 && pending) ? (
                <Skeleton variant="rounded" width={120} height={24} sx={{ borderRadius: 999 }} />
              ) : shown.length > 0 ? (
                shown.map((item) => <ProblemPill key={item.key} item={item} />)
              ) : (
                <HealthyPill unchecked={unchecked} />
              )}
            </Box>
          </>
        )}
      </ButtonBase>
    </Box>
  );
}

function Stat({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <Box component="span" title={title} sx={{ width: 88, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ lineHeight: 1.35 }}>
        {label}
      </Typography>
      <Typography component="span" variant="body2" noWrap sx={{ fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.5 }}>
        {children}
      </Typography>
    </Box>
  );
}

const METRICS_TEXT = { loading: 'Checking metrics', missing: 'metrics-server is not serving data', waiting: 'Waiting for the first sample', ok: undefined };

/** CPU or memory in use across the cluster as a percentage over a thin meter. */
function UsageStat({ label, pct, state }: { label: string; pct: number | undefined; state: keyof typeof METRICS_TEXT }) {
  const tone = pct === undefined ? undefined : pct > 90 ? 'error' : pct > 75 ? 'warning' : undefined;
  if (state === 'loading') return <StatSkeleton />;
  return (
    <Box component="span" title={METRICS_TEXT[state] ?? `${label} in use across the cluster`} sx={{ width: 88, display: 'flex', flexDirection: 'column' }}>
      <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ lineHeight: 1.35 }}>
        {label}
      </Typography>
      {pct === undefined ? (
        <Typography component="span" variant="body2" noWrap sx={{ lineHeight: 1.5, display: 'inline-flex', alignItems: 'baseline', gap: 0.5 }}>
          <Box component="span" aria-hidden sx={{ color: 'text.disabled', fontWeight: 650 }}>
            —
          </Box>
          <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.75rem' }}>
            {state === 'missing' ? 'no metrics' : 'waiting'}
          </Box>
        </Typography>
      ) : (
        <>
          <Typography
            component="span"
            variant="body2"
            sx={{ fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.5, color: tone ? statusTextColor(tone) : 'text.primary' }}
          >
            {`${pct.toFixed(0)}%`}
          </Typography>
          <Box
            component="span"
            aria-hidden
            sx={(t) => ({ display: 'block', height: 4, mt: 0.25, borderRadius: 2, overflow: 'hidden', bgcolor: alpha(t.palette.text.primary, t.palette.mode === 'dark' ? 0.12 : 0.08) })}
          >
            <Box
              component="span"
              sx={(t: Theme) => ({ display: 'block', height: '100%', width: `${Math.min(100, Math.max(pct, 2))}%`, borderRadius: 2, bgcolor: tone ? t.palette[tone].main : t.palette.primary.main })}
            />
          </Box>
        </>
      )}
    </Box>
  );
}

function StatSkeleton() {
  return (
    <Box component="span" sx={{ width: 88, display: 'flex', flexDirection: 'column' }}>
      <Skeleton width={48} height={16} />
      <Skeleton width={56} height={20} />
    </Box>
  );
}

const pillSx = (tone: 'error' | 'warning' | 'success') => (t: Theme) => ({
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 0.5,
  height: 24,
  px: 1,
  borderRadius: 999,
  whiteSpace: 'nowrap' as const,
  lineHeight: '24px',
  bgcolor: alpha(t.palette[tone].main, t.palette.mode === 'dark' ? 0.15 : 0.085),
});

function ProblemPill({ item }: { item: AttentionItem }) {
  return (
    <Box component="span" title={item.detail} sx={pillSx(item.tone)}>
      <Typography component="span" variant="body2" sx={{ fontWeight: 700, color: statusTextColor(item.tone), fontVariantNumeric: 'tabular-nums', lineHeight: 'inherit' }}>
        {item.count}
      </Typography>
      <Typography component="span" variant="body2" sx={{ lineHeight: 'inherit' }}>
        {pillLabel(item)}
      </Typography>
    </Box>
  );
}

function HealthyPill({ unchecked }: { unchecked: string[] }) {
  return (
    <>
      <Box component="span" sx={[pillSx('success'), { alignItems: 'center' }]}>
        <CheckCircleOutlineIcon sx={{ fontSize: 15, color: statusTextColor('success') }} />
        <Typography component="span" variant="body2" sx={{ lineHeight: 'inherit', fontWeight: 600, color: statusTextColor('success') }}>
          Healthy
        </Typography>
      </Box>
      {unchecked.length > 0 && (
        <Typography component="span" variant="caption" color="text.secondary" title={`Could not check ${unchecked.join(', ')}: no access`} sx={{ lineHeight: '24px' }}>
          {unchecked.length} {unchecked.length === 1 ? 'kind' : 'kinds'} not checked
        </Typography>
      )}
    </>
  );
}
