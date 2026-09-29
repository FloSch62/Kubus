import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import { alpha, useTheme } from '@mui/material/styles';
import QueryStatsOutlinedIcon from '@mui/icons-material/QueryStatsOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import SdStorageOutlinedIcon from '@mui/icons-material/SdStorageOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import { LineChart } from '@mui/x-charts/LineChart';
import type { ClusterMetricsSummary, MetricsSeriesEntry } from '@kubus/shared';
import { invalidateMetricsServer, useMetricsServerStatus, useMetricsSummary } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { ClusterSectionHeader } from '../components/ClusterSectionHeader.js';
import { PageHeader } from '../components/PageHeader.js';
import { EmptyState } from '../components/EmptyState.js';
import { UsageRanking, type UsageRankingRow } from '../components/UsageRanking.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { InstallMetricsServerButton, UninstallMetricsServerButton } from '../components/MetricsServerControls.js';
import { formatBytes, formatCpu } from '../components/format.js';
import { SERIES_DARK, SERIES_LIGHT, formatAxisValue, metricColors, niceValueTicks, timeAxisTicks } from '../components/chart-theme.js';

const MAX_NODE_SERIES = 8;
const MAX_NAMESPACE_BARS = 10;

export function MetricsPage() {
  const selected = useClustersStore((s) => s.selected);

  if (selected.length === 0) {
    return <NoClustersState icon={<QueryStatsOutlinedIcon />} />;
  }

  // One cluster: its name and controls sit in the page header. Several:
  // the page header names the page and each cluster gets its own section header.
  if (selected.length === 1) {
    return (
      <Box sx={{ p: 1.5 }}>
        <ClusterMetricsSection ctx={selected[0]!} single />
      </Box>
    );
  }
  return (
    <Stack spacing={3} sx={{ p: 2 }}>
      <PageHeader title="Metrics" icon={<QueryStatsOutlinedIcon />}>
        <Typography variant="body2" color="text.secondary">
          {selected.length} clusters
        </Typography>
      </PageHeader>
      {selected.map((ctx) => (
        <ClusterMetricsSection key={ctx} ctx={ctx} />
      ))}
    </Stack>
  );
}

function ClusterMetricsSection({ ctx, single = false }: { ctx: string; single?: boolean }) {
  // The hook polls fast on its own while an install is settling.
  const { data: status, error: statusError } = useMetricsServerStatus(ctx);
  const { data: summary, error: summaryError } = useMetricsSummary(ctx);
  const error = statusError ?? summaryError;
  const qc = useQueryClient();

  const installed = status?.installed ?? false;
  const available = summary?.available ?? false;

  const controls = (
    <>
      {status?.version && <Chip size="small" variant="outlined" label={`metrics-server ${status.version}`} />}
      {installed && (
        <Chip
          size="small"
          variant="outlined"
          color={available ? 'success' : 'warning'}
          label={available ? 'collecting' : status?.ready ? 'waiting for samples' : 'starting'}
        />
      )}
      {/* One-shot refetch, independent of the cadence preset — works while polling is paused. */}
      <Tooltip title="Refresh metrics now">
        <IconButton size="small" aria-label={`Refresh metrics for ${ctx}`} onClick={() => invalidateMetricsServer(qc, ctx)}>
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box sx={{ flex: 1 }} />
      {installed && <UninstallMetricsServerButton ctx={ctx} status={status} trigger="menu" />}
    </>
  );

  return (
    <Box>
      {single ? (
        <PageHeader title="Metrics" icon={<QueryStatsOutlinedIcon />}>
          <Typography variant="body2" color="text.secondary">
            {ctx}
          </Typography>
          {controls}
        </PageHeader>
      ) : (
        <ClusterSectionHeader ctx={ctx}>{controls}</ClusterSectionHeader>
      )}

      {error && <Alert severity="error">{error.message}</Alert>}
      {!error && !status && <Skeleton variant="rounded" height={140} />}

      {status && !installed && !available && (
        <Card variant="outlined">
          <EmptyState
            icon={<QueryStatsOutlinedIcon />}
            title="metrics-server is not installed"
            subtitle="metrics-server collects CPU and memory usage from every node's kubelet and serves it through the metrics.k8s.io API. It powers the graphs on this page, the usage columns in resource lists and the Overview node gauges."
          >
            <InstallMetricsServerButton ctx={ctx} />
          </EmptyState>
        </Card>
      )}

      {status && installed && !available && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {status.ready
                ? 'metrics-server is running — waiting for the first usage samples (up to a minute).'
                : 'metrics-server is starting. If it stays here for minutes, the kubelet TLS handshake may be failing — uninstall and reinstall with "Skip kubelet TLS verification" enabled.'}
            </Typography>
            <LinearProgress />
          </CardContent>
        </Card>
      )}

      {available && summary && <ClusterCharts summary={summary} />}
    </Box>
  );
}

function ClusterCharts({ summary }: { summary: ClusterMetricsSummary }) {
  const mode = useTheme().palette.mode;
  const series = mode === 'dark' ? SERIES_DARK : SERIES_LIGHT;
  const { cpu: cpuColor, memory: memColor } = metricColors(mode);

  const latest = summary.clusterSeries.at(-1);
  const cpuPct = latest && summary.cpuCapacityMilli ? (latest.cpuMilli / summary.cpuCapacityMilli) * 100 : undefined;
  const memPct = latest && summary.memCapacityBytes ? (latest.memBytes / summary.memCapacityBytes) * 100 : undefined;

  return (
    <Stack spacing={1.5}>
      <Grid container spacing={1.5}>
        <StatTile
          icon={<MemoryOutlinedIcon />}
          label="CPU"
          value={latest ? formatCpu(latest.cpuMilli) : '—'}
          sub={cpuPct !== undefined ? `${cpuPct.toFixed(0)}% of ${formatCpu(summary.cpuCapacityMilli!)}` : undefined}
        />
        <StatTile
          icon={<SdStorageOutlinedIcon />}
          label="Memory"
          value={latest ? formatBytes(latest.memBytes) : '—'}
          sub={memPct !== undefined ? `${memPct.toFixed(0)}% of ${formatBytes(summary.memCapacityBytes!)}` : undefined}
        />
        <StatTile icon={<DnsOutlinedIcon />} label="Nodes measured" value={summary.nodes.length} sub="with usage samples" />
        <StatTile icon={<ViewInArOutlinedIcon />} label="Pods measured" value={summary.podCount} sub="running pods with usage samples" />
      </Grid>

      {summary.clusterSeries.length < 2 ? (
        <Alert severity="info" variant="outlined">
          Collecting samples — graphs appear after a couple of polls (~40 seconds).
        </Alert>
      ) : (
        <>
          <Grid container spacing={1.5}>
            <ChartCard title="Cluster CPU" sub={summary.cpuCapacityMilli ? `capacity ${formatCpu(summary.cpuCapacityMilli)}` : undefined}>
              <UsageLineChart entries={[{ name: 'CPU', series: summary.clusterSeries }]} metric="cpu" colors={[cpuColor]} area hideLegend />
            </ChartCard>
            <ChartCard title="Cluster memory" sub={summary.memCapacityBytes ? `capacity ${formatBytes(summary.memCapacityBytes)}` : undefined}>
              <UsageLineChart entries={[{ name: 'Memory', series: summary.clusterSeries }]} metric="mem" colors={[memColor]} area hideLegend />
            </ChartCard>
          </Grid>

          {summary.nodes.length > 1 && (
            <Grid container spacing={1.5}>
              <ChartCard title="CPU by node" sub={nodeOverflowNote(summary.nodes.length)}>
                <UsageLineChart entries={topEntries(summary.nodes, 'cpu', MAX_NODE_SERIES)} metric="cpu" colors={series} />
              </ChartCard>
              <ChartCard title="Memory by node" sub={nodeOverflowNote(summary.nodes.length)}>
                <UsageLineChart entries={topEntries(summary.nodes, 'mem', MAX_NODE_SERIES)} metric="mem" colors={series} />
              </ChartCard>
            </Grid>
          )}

          <Grid container spacing={1.5}>
            <ChartCard title="Top pods by CPU" sub={summary.cpuCapacityMilli ? 'latest sample · % of cluster capacity' : 'latest sample'}>
              <UsageRanking rows={podRanking(summary.topPodsCpu, 'cpu', summary.cpuCapacityMilli)} colors={[cpuColor]} format={formatCpu} />
            </ChartCard>
            <ChartCard title="Top pods by memory" sub={summary.memCapacityBytes ? 'latest sample · % of cluster capacity' : 'latest sample'}>
              <UsageRanking rows={podRanking(summary.topPodsMem, 'mem', summary.memCapacityBytes)} colors={[memColor]} format={formatBytes} />
            </ChartCard>
          </Grid>

          <Grid container spacing={1.5}>
            <ChartCard title="CPU by namespace" sub={summary.cpuCapacityMilli ? '% of cluster capacity' : undefined}>
              <UsageRanking rows={namespaceRanking(summary, 'cpu', summary.cpuCapacityMilli)} colors={[cpuColor]} format={formatCpu} />
            </ChartCard>
            <ChartCard title="Memory by namespace" sub={summary.memCapacityBytes ? '% of cluster capacity' : undefined}>
              <UsageRanking rows={namespaceRanking(summary, 'mem', summary.memCapacityBytes)} colors={[memColor]} format={formatBytes} />
            </ChartCard>
          </Grid>

          <NamespaceTable summary={summary} />
        </>
      )}
    </Stack>
  );
}

// ---- chart building blocks ----

type Metric = 'cpu' | 'mem';

const metricValue = (metric: Metric) => (s: { cpuMilli: number; memBytes: number }) => (metric === 'cpu' ? s.cpuMilli : s.memBytes);
const metricFormat = (metric: Metric) => (metric === 'cpu' ? formatCpu : formatBytes);

/** Top `limit` entries by latest usage, kept in stable (alphabetical) order so colors follow entities across refetches. */
function topEntries(entries: MetricsSeriesEntry[], metric: Metric, limit: number): MetricsSeriesEntry[] {
  if (entries.length <= limit) return entries;
  const value = metricValue(metric);
  const keep = new Set(
    [...entries]
      .sort((a, b) => value(b.series.at(-1) ?? { cpuMilli: 0, memBytes: 0 }) - value(a.series.at(-1) ?? { cpuMilli: 0, memBytes: 0 }))
      .slice(0, limit)
      .map((e) => e.name),
  );
  return entries.filter((e) => keep.has(e.name));
}

function nodeOverflowNote(count: number): string | undefined {
  return count > MAX_NODE_SERIES ? `busiest ${MAX_NODE_SERIES} of ${count} nodes` : undefined;
}

/** Pods by latest usage: name first, namespace underneath, share of cluster capacity. */
function podRanking(entries: MetricsSeriesEntry[], metric: Metric, capacity: number | undefined): UsageRankingRow[] {
  const value = metricValue(metric);
  return entries.map((e) => {
    const v = value(e.series.at(-1) ?? { cpuMilli: 0, memBytes: 0 });
    return { key: `${e.namespace ?? ''}/${e.name}`, name: e.name, detail: e.namespace, values: [v], share: capacity ? v / capacity : undefined };
  });
}

function namespaceRanking(summary: ClusterMetricsSummary, metric: Metric, capacity: number | undefined): UsageRankingRow[] {
  const value = metricValue(metric);
  const sorted = [...summary.namespaces].sort((a, b) => value(b) - value(a));
  const rows: UsageRankingRow[] = sorted.slice(0, MAX_NAMESPACE_BARS).map((n) => ({
    key: n.namespace,
    name: n.namespace,
    detail: `${n.pods} ${n.pods === 1 ? 'pod' : 'pods'}`,
    values: [value(n)],
    share: capacity ? value(n) / capacity : undefined,
  }));
  const rest = sorted.slice(MAX_NAMESPACE_BARS);
  if (rest.length) {
    const total = rest.reduce((sum, n) => sum + value(n), 0);
    rows.push({ key: '(rest)', name: `${rest.length} more namespaces`, values: [total], share: capacity ? total / capacity : undefined });
  }
  return rows;
}

function UsageLineChart({
  entries,
  metric,
  colors,
  area,
  hideLegend,
}: {
  entries: MetricsSeriesEntry[];
  metric: Metric;
  colors: string[];
  area?: boolean;
  hideLegend?: boolean;
}) {
  const value = metricValue(metric);
  const fmt = metricFormat(metric);
  // One shared time axis: ticks are aligned across entries because samples of
  // a poll share a timestamp; entries missing a tick chart as null (gap).
  const { times, data, peak } = useMemo(() => {
    const tickSet = new Set<number>();
    for (const e of entries) for (const s of e.series) tickSet.add(s.t);
    const ticks = [...tickSet].sort((a, b) => a - b);
    const index = new Map(ticks.map((t, i) => [t, i]));
    let peak = 0;
    const rows = entries.map((e) => {
      const row: (number | null)[] = Array.from({ length: ticks.length }, () => null);
      for (const s of e.series) {
        const v = value(s);
        row[index.get(s.t)!] = v;
        peak = Math.max(peak, v);
      }
      return row;
    });
    return { times: ticks.map((t) => new Date(t)), data: rows, peak };
  }, [entries, value]);
  const timeAxis = useMemo(() => timeAxisTicks(times), [times]);
  const unit = metric === 'cpu' ? 'cpu' : 'bytes';
  const valueTicks = niceValueTicks(peak, unit);

  return (
    <LineChart
      height={220}
      series={entries.map((e, i) => ({
        data: data[i]!,
        label: e.name,
        color: colors[i % colors.length],
        showMark: false,
        area,
        valueFormatter: (v: number | null) => (v === null ? '' : fmt(v)),
      }))}
      xAxis={[{ data: times, scaleType: 'time', ...timeAxis }]}
      yAxis={[{ min: 0, max: valueTicks.max, tickInterval: valueTicks.tickInterval, valueFormatter: (v: number) => formatAxisValue(unit, v), width: 64 }]}
      grid={{ horizontal: true }}
      hideLegend={hideLegend ?? entries.length < 2}
      sx={area ? { '& .MuiLineChart-area': { fillOpacity: 0.2 } } : undefined}
      slotProps={{ legend: { sx: { fontSize: 12 } } }}
    />
  );
}

/** Accessible twin of the charts: exact per-namespace numbers. */
function NamespaceTable({ summary }: { summary: ClusterMetricsSummary }) {
  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Usage by namespace
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Namespace</TableCell>
              <TableCell align="right">Pods</TableCell>
              <TableCell align="right">CPU</TableCell>
              <TableCell align="right">Memory</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {summary.namespaces.map((n) => (
              <TableRow key={n.namespace}>
                <TableCell>{n.namespace}</TableCell>
                <TableCell align="right">{n.pods}</TableCell>
                <TableCell align="right">{formatCpu(n.cpuMilli)}</TableCell>
                <TableCell align="right">{formatBytes(n.memBytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <Grid size={{ xs: 12, lg: 6 }}>
      <Card variant="outlined" sx={{ height: '100%' }}>
        <CardContent sx={{ py: 1.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 0.5 }}>
            <Typography variant="subtitle2">{title}</Typography>
            {sub && (
              <Typography variant="caption" color="text.secondary">
                {sub}
              </Typography>
            )}
          </Stack>
          {children}
        </CardContent>
      </Card>
    </Grid>
  );
}

function StatTile({ icon, label, value, sub }: { icon: React.ReactElement; label: string; value: number | string; sub?: string }) {
  return (
    <Grid size={{ xs: 6, sm: 3 }}>
      <Card variant="outlined" sx={{ height: '100%' }}>
        <CardContent sx={{ py: '12px !important', display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box
            sx={(theme) => ({
              width: 36,
              height: 36,
              borderRadius: 1.5,
              flexShrink: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'primary.main',
              bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.08),
              '& svg': { fontSize: 20 },
            })}
          >
            {icon}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              {label}
            </Typography>
            <Typography variant="h6" noWrap>
              {value}
            </Typography>
            {sub && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', mt: -0.5 }}>
                {sub}
              </Typography>
            )}
          </Box>
        </CardContent>
      </Card>
    </Grid>
  );
}
