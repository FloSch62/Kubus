import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
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
import { alpha, useTheme } from '@mui/material/styles';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import QueryStatsOutlinedIcon from '@mui/icons-material/QueryStatsOutlined';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import SdStorageOutlinedIcon from '@mui/icons-material/SdStorageOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import type { ClusterMetricsSummary, MetricsSeriesEntry } from '@kubus/shared';
import { useMetricsServerStatus, useMetricsSummary } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { EmptyState } from '../components/EmptyState.js';
import { InstallMetricsServerButton, UninstallMetricsServerButton } from '../components/MetricsServerControls.js';
import { formatBytes, formatCpu } from '../components/format.js';

// Categorical palette from the validated dataviz reference set (adjacent-pair
// CVD-safe in this order — do not re-order or cycle past 8 series).
const SERIES_LIGHT = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948'];
const SERIES_DARK = ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'];
const MAX_NODE_SERIES = 8;
const MAX_NAMESPACE_BARS = 10;

const timeFormatter = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function MetricsPage() {
  const selected = useClustersStore((s) => s.selected);

  if (selected.length === 0) {
    return <EmptyState icon={<QueryStatsOutlinedIcon />} title="Metrics" subtitle="Select one or more clusters in the top bar to see usage graphs." />;
  }

  return (
    <Stack spacing={3} sx={{ p: 2 }}>
      {selected.map((ctx) => (
        <ClusterMetricsSection key={ctx} ctx={ctx} />
      ))}
    </Stack>
  );
}

function ClusterMetricsSection({ ctx }: { ctx: string }) {
  // Poll status faster than the nav does: this page is where install progress is watched.
  const { data: status, error: statusError } = useMetricsServerStatus(ctx, { refetchMs: 5_000 });
  const { data: summary, error: summaryError } = useMetricsSummary(ctx);
  const error = statusError ?? summaryError;

  const installed = status?.installed ?? false;
  const available = summary?.available ?? false;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <HubOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
        <Typography variant="h6">{ctx}</Typography>
        {status?.version && <Chip size="small" variant="outlined" label={`metrics-server ${status.version}`} />}
        {installed && (
          <Chip
            size="small"
            variant="outlined"
            color={available ? 'success' : 'warning'}
            label={available ? 'collecting' : status?.ready ? 'waiting for samples' : 'starting'}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {installed && <UninstallMetricsServerButton ctx={ctx} status={status} />}
      </Stack>

      {error && <Alert severity="error">{error.message}</Alert>}
      {!error && !status && <LinearProgress />}

      {status && !installed && !available && (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="subtitle2">metrics-server is not installed in this cluster</Typography>
              <Typography variant="body2" color="text.secondary">
                metrics-server collects CPU and memory usage from every node's kubelet and serves it through the metrics.k8s.io API —
                powering the graphs on this page, the usage columns in resource lists, and the Overview node gauges.
              </Typography>
              <InstallMetricsServerButton ctx={ctx} />
            </Stack>
          </CardContent>
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
  const dark = useTheme().palette.mode === 'dark';
  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  const cpuColor = series[0]!;
  const memColor = series[1]!;

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
        <StatTile icon={<DnsOutlinedIcon />} label="Nodes reporting" value={summary.nodes.length} />
        <StatTile icon={<ViewInArOutlinedIcon />} label="Pods reporting" value={summary.podCount} />
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
            <ChartCard title="Top pods by CPU">
              <TopBarChart entries={summary.topPodsCpu} metric="cpu" color={cpuColor} />
            </ChartCard>
            <ChartCard title="Top pods by memory">
              <TopBarChart entries={summary.topPodsMem} metric="mem" color={memColor} />
            </ChartCard>
          </Grid>

          <Grid container spacing={1.5}>
            <ChartCard title="CPU by namespace">
              <NamespaceBarChart summary={summary} metric="cpu" color={cpuColor} />
            </ChartCard>
            <ChartCard title="Memory by namespace">
              <NamespaceBarChart summary={summary} metric="mem" color={memColor} />
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
  const { times, data } = useMemo(() => {
    const tickSet = new Set<number>();
    for (const e of entries) for (const s of e.series) tickSet.add(s.t);
    const ticks = [...tickSet].sort((a, b) => a - b);
    const index = new Map(ticks.map((t, i) => [t, i]));
    const rows = entries.map((e) => {
      const row: (number | null)[] = Array.from({ length: ticks.length }, () => null);
      for (const s of e.series) row[index.get(s.t)!] = value(s);
      return row;
    });
    return { times: ticks.map((t) => new Date(t)), data: rows };
  }, [entries, value]);

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
      xAxis={[{ data: times, scaleType: 'time', valueFormatter: timeFormatter }]}
      yAxis={[{ min: 0, valueFormatter: (v: number) => fmt(v), width: 56 }]}
      grid={{ horizontal: true }}
      hideLegend={hideLegend ?? entries.length < 2}
      sx={area ? { '& .MuiLineChart-area': { fillOpacity: 0.25 } } : undefined}
      slotProps={{ legend: { sx: { fontSize: 12 } } }}
    />
  );
}

function TopBarChart({ entries, metric, color }: { entries: MetricsSeriesEntry[]; metric: Metric; color: string }) {
  const value = metricValue(metric);
  const fmt = metricFormat(metric);
  const names = entries.map((e) => (e.namespace ? `${e.namespace}/${e.name}` : e.name));
  const values = entries.map((e) => value(e.series.at(-1) ?? { cpuMilli: 0, memBytes: 0 }));
  return (
    <BarChart
      layout="horizontal"
      height={Math.max(160, entries.length * 30 + 60)}
      series={[{ data: values, valueFormatter: (v: number | null) => (v === null ? '' : fmt(v)), color }]}
      yAxis={[{ data: names, scaleType: 'band', width: 190, tickLabelStyle: { fontSize: 11 } }]}
      xAxis={[{ min: 0, valueFormatter: (v: number) => fmt(v) }]}
      grid={{ vertical: true }}
      hideLegend
    />
  );
}

function NamespaceBarChart({ summary, metric, color }: { summary: ClusterMetricsSummary; metric: Metric; color: string }) {
  const value = metricValue(metric);
  const fmt = metricFormat(metric);
  const sorted = [...summary.namespaces].sort((a, b) => value(b) - value(a));
  const shown = sorted.slice(0, MAX_NAMESPACE_BARS);
  const rest = sorted.slice(MAX_NAMESPACE_BARS);
  const names = shown.map((n) => n.namespace);
  const values = shown.map((n) => value(n));
  if (rest.length) {
    names.push(`(${rest.length} more)`);
    values.push(rest.reduce((sum, n) => sum + value(n), 0));
  }
  return (
    <BarChart
      layout="horizontal"
      height={Math.max(160, names.length * 30 + 60)}
      series={[{ data: values, valueFormatter: (v: number | null) => (v === null ? '' : fmt(v)), color }]}
      yAxis={[{ data: names, scaleType: 'band', width: 150, tickLabelStyle: { fontSize: 11 } }]}
      xAxis={[{ min: 0, valueFormatter: (v: number) => fmt(v) }]}
      grid={{ vertical: true }}
      hideLegend
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
              borderRadius: 2,
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
