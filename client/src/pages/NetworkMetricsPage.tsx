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
import Skeleton from '@mui/material/Skeleton';
import { alpha, useTheme } from '@mui/material/styles';
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined';
import SpeedOutlinedIcon from '@mui/icons-material/SpeedOutlined';
import SyncAltOutlinedIcon from '@mui/icons-material/SyncAltOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import type { ClusterNetworkSummary, NetworkPeer, NetworkSeriesEntry } from '@kubus/shared';
import { useNetworkAgentStatus, useNetworkSummary } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { ClusterSectionHeader } from '../components/ClusterSectionHeader.js';
import { NoClustersState } from '../components/NoClustersState.js';
import { InstallNetworkAgentButton, UninstallNetworkAgentButton } from '../components/NetworkAgentControls.js';
import { formatBps } from '../components/format.js';
import { SERIES_DARK, SERIES_LIGHT, timeTickFormatter } from '../components/chart-theme.js';

// Sent/received pair from the shared chart palette (same set as MetricsPage).
const SENT_COLOR = { light: SERIES_LIGHT[0]!, dark: SERIES_DARK[0]! };
const RECV_COLOR = { light: SERIES_LIGHT[1]!, dark: SERIES_DARK[1]! };
const MAX_LINK_ROWS = 50;

export function NetworkMetricsPage() {
  const selected = useClustersStore((s) => s.selected);

  if (selected.length === 0) {
    return <NoClustersState icon={<NetworkCheckOutlinedIcon />} />;
  }

  return (
    <Stack spacing={3} sx={{ p: 2 }}>
      {selected.map((ctx) => (
        <ClusterNetworkSection key={ctx} ctx={ctx} />
      ))}
    </Stack>
  );
}

function ClusterNetworkSection({ ctx }: { ctx: string }) {
  // The hook polls fast on its own while an install is settling.
  const { data: status, error: statusError } = useNetworkAgentStatus(ctx);
  const { data: summary, error: summaryError } = useNetworkSummary(ctx);
  const error = statusError ?? summaryError;

  const installed = status?.installed ?? false;
  const available = summary?.available ?? false;

  return (
    <Box>
      <ClusterSectionHeader ctx={ctx}>
        {status?.version && <Chip size="small" variant="outlined" label={`retina ${status.version}`} />}
        {installed && (
          <Chip
            size="small"
            variant="outlined"
            color={available ? 'success' : 'warning'}
            label={available ? 'collecting' : status?.ready ? 'waiting for samples' : 'starting'}
          />
        )}
        {installed && status && status.nodesDesired > 0 && (
          <Chip size="small" variant="outlined" label={`${status.nodesReady}/${status.nodesDesired} nodes`} />
        )}
        <Box sx={{ flex: 1 }} />
        {installed && <UninstallNetworkAgentButton ctx={ctx} status={status} />}
      </ClusterSectionHeader>

      {error && <Alert severity="error">{error.message}</Alert>}
      {!error && !status && <Skeleton variant="rounded" height={140} />}

      {status && !installed && !available && (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="subtitle2">The network agent is not installed in this cluster</Typography>
              <Typography variant="body2" color="text.secondary">
                Kubus deploys Microsoft's open-source Retina agent as a DaemonSet and reads its eBPF traffic counters through the
                Kubernetes API — powering live pod-to-pod throughput and the busiest-links table on this page. No Prometheus or other
                backend is required, and it works with any CNI.
              </Typography>
              <InstallNetworkAgentButton ctx={ctx} />
            </Stack>
          </CardContent>
        </Card>
      )}

      {status && installed && !available && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {status.ready
                ? 'The network agent is running — waiting for the first traffic samples (up to a minute).'
                : 'The network agent is starting on every node. If it stays here for minutes, check the retina-agent pods in kube-system for pull or scheduling errors.'}
            </Typography>
            <LinearProgress />
          </CardContent>
        </Card>
      )}

      {available && summary && <NetworkCharts summary={summary} />}
    </Box>
  );
}

function NetworkCharts({ summary }: { summary: ClusterNetworkSummary }) {
  const dark = useTheme().palette.mode === 'dark';
  const sentColor = dark ? SENT_COLOR.dark : SENT_COLOR.light;
  const recvColor = dark ? RECV_COLOR.dark : RECV_COLOR.light;

  const latest = summary.clusterSeries.at(-1);

  return (
    <Stack spacing={1.5}>
      <Grid container spacing={1.5}>
        <StatTile icon={<SpeedOutlinedIcon />} label="Throughput" value={latest ? formatBps(latest.bps) : '—'} />
        <StatTile icon={<SyncAltOutlinedIcon />} label="Traffic links" value={summary.linkCount} />
        <StatTile icon={<ViewInArOutlinedIcon />} label="Pods with traffic" value={summary.podCount} />
        <StatTile icon={<DnsOutlinedIcon />} label="Agents reporting" value={`${summary.agentsReady}/${summary.agentsDesired}`} />
      </Grid>

      {summary.clusterSeries.length < 2 ? (
        <Alert severity="info" variant="outlined">
          Collecting samples — graphs appear after a couple of polls (~40 seconds).
        </Alert>
      ) : (
        <>
          <Grid container spacing={1.5}>
            <ChartCard title="Cluster traffic" sub="all observed flows, each counted once">
              <ThroughputLineChart series={summary.clusterSeries} color={sentColor} />
            </ChartCard>
            <ChartCard title="Top pods by traffic" sub="sent + received, latest sample">
              <TopPodsBarChart summary={summary} sentColor={sentColor} recvColor={recvColor} />
            </ChartCard>
          </Grid>

          <LinksTable summary={summary} />
        </>
      )}
    </Stack>
  );
}

// ---- chart building blocks ----

function ThroughputLineChart({ series, color }: { series: ClusterNetworkSummary['clusterSeries']; color: string }) {
  const times = useMemo(() => series.map((s) => new Date(s.t)), [series]);
  return (
    <LineChart
      height={240}
      series={[
        {
          data: series.map((s) => s.bps),
          label: 'Traffic',
          color,
          showMark: false,
          area: true,
          valueFormatter: (v: number | null) => (v === null ? '' : formatBps(v)),
        },
      ]}
      xAxis={[{ data: times, scaleType: 'time', valueFormatter: timeTickFormatter(times) }]}
      yAxis={[{ min: 0, valueFormatter: (v: number) => formatBps(v), width: 72 }]}
      grid={{ horizontal: true }}
      hideLegend
      sx={{ '& .MuiLineChart-area': { fillOpacity: 0.25 } }}
    />
  );
}

function TopPodsBarChart({ summary, sentColor, recvColor }: { summary: ClusterNetworkSummary; sentColor: string; recvColor: string }) {
  // Merge the sent/recv top lists into one ranking by combined rate so a
  // single chart shows both directions per pod.
  const { names, sent, recv } = useMemo(() => {
    const byKey = new Map<string, { name: string; sent: number; recv: number }>();
    const add = (e: NetworkSeriesEntry) => {
      const key = e.namespace ? `${e.namespace}/${e.name}` : e.name;
      if (byKey.has(key)) return;
      const latest = e.series.at(-1);
      byKey.set(key, { name: key, sent: latest?.sentBps ?? 0, recv: latest?.recvBps ?? 0 });
    };
    summary.topPodsSent.forEach(add);
    summary.topPodsRecv.forEach(add);
    const rows = [...byKey.values()].sort((a, b) => b.sent + b.recv - (a.sent + a.recv)).slice(0, 10);
    return { names: rows.map((r) => r.name), sent: rows.map((r) => r.sent), recv: rows.map((r) => r.recv) };
  }, [summary]);

  return (
    <BarChart
      layout="horizontal"
      height={Math.max(160, names.length * 32 + 60)}
      series={[
        { data: sent, label: 'Sent', color: sentColor, stack: 'traffic', valueFormatter: (v: number | null) => (v === null ? '' : formatBps(v)) },
        { data: recv, label: 'Received', color: recvColor, stack: 'traffic', valueFormatter: (v: number | null) => (v === null ? '' : formatBps(v)) },
      ]}
      yAxis={[{ data: names, scaleType: 'band', width: 190, tickLabelStyle: { fontSize: 11 } }]}
      xAxis={[{ min: 0, valueFormatter: (v: number) => formatBps(v) }]}
      grid={{ vertical: true }}
      slotProps={{ legend: { sx: { fontSize: 12 } } }}
    />
  );
}

const PEER_KIND_LABEL: Record<NetworkPeer['kind'], string | undefined> = {
  pod: undefined,
  service: 'svc',
  node: 'node',
  external: 'ext',
};

function PeerCell({ peer }: { peer: NetworkPeer }) {
  const kind = PEER_KIND_LABEL[peer.kind];
  return (
    <TableCell sx={{ whiteSpace: 'nowrap' }}>
      {kind && <Chip size="small" variant="outlined" label={kind} sx={{ mr: 0.75, height: 18, fontSize: 10.5 }} />}
      {peer.namespace ? `${peer.namespace}/${peer.name}` : peer.name}
    </TableCell>
  );
}

/** Accessible twin of the charts: the busiest observed traffic links. */
function LinksTable({ summary }: { summary: ClusterNetworkSummary }) {
  const rows = summary.links.slice(0, MAX_LINK_ROWS);
  const perSec = (v: number) => (v > 0 ? `${v < 10 ? v.toFixed(1) : Math.round(v)}/s` : '—');
  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 1 }}>
          <Typography variant="subtitle2">Busiest links</Typography>
          {summary.linkCount > rows.length && (
            <Typography variant="caption" color="text.secondary">
              showing {rows.length} of {summary.linkCount}
            </Typography>
          )}
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Endpoint A</TableCell>
              <TableCell>Endpoint B</TableCell>
              <TableCell align="right">A → B</TableCell>
              <TableCell align="right">B → A</TableCell>
              <TableCell align="right">Retrans</TableCell>
              <TableCell align="right">Dropped</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((link, i) => (
              <TableRow key={i} hover>
                <PeerCell peer={link.a} />
                <PeerCell peer={link.b} />
                <TableCell align="right">{formatBps(link.abBps)}</TableCell>
                <TableCell align="right">{formatBps(link.baBps)}</TableCell>
                <TableCell align="right">{perSec(link.retransmitsPerSec)}</TableCell>
                <TableCell align="right">{link.droppedBps > 0 ? formatBps(link.droppedBps) : '—'}</TableCell>
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
