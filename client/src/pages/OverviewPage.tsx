import { Alert, Box, Card, CardContent, Chip, Grid, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import { useNavigate } from 'react-router';
import { useNodeMetrics, useOverview } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { AgeCell } from '../components/AgeCell.js';
import { EmptyState } from '../components/EmptyState.js';
import { StatusChip } from '../components/StatusChip.js';
import { formatBytes, formatCpu } from '../components/Sparkline.js';

export function OverviewPage() {
  const selected = useClustersStore((s) => s.selected);

  if (selected.length === 0) {
    return (
      <EmptyState
        icon={
          <Box
            component="img"
            src="/kubus.svg"
            alt=""
            aria-hidden
            sx={{ width: 48, height: 54, objectFit: 'contain' }}
          />
        }
        title="Welcome to Kubus"
        subtitle="Select one or more clusters in the top bar to get started."
      />
    );
  }

  return (
    <Stack spacing={3} sx={{ p: 2 }}>
      {selected.map((ctx) => (
        <ClusterOverviewSection key={ctx} ctx={ctx} />
      ))}
    </Stack>
  );
}

function ClusterOverviewSection({ ctx }: { ctx: string }) {
  const { data, isLoading, error } = useOverview(ctx);
  const { data: nodeMetrics } = useNodeMetrics(ctx);
  const navigate = useNavigate();

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <HubOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
        <Typography variant="h6">{ctx}</Typography>
      </Stack>
      {isLoading && <LinearProgress />}
      {error && <Alert severity="error">{error.message}</Alert>}
      {data && (
        <>
          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            <StatCard label="Nodes" value={data.counts.nodes} icon={<DnsOutlinedIcon />} onClick={() => navigate('/r/core/v1/nodes')} />
            <StatCard label="Namespaces" value={data.counts.namespaces} icon={<WorkspacesOutlinedIcon />} onClick={() => navigate('/r/core/v1/namespaces')} />
            <StatCard
              label="Pods"
              value={`${data.counts.podsRunning}/${data.counts.pods}`}
              sub="running"
              warn={data.counts.podsRunning < data.counts.pods}
              icon={<ViewInArOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/pods')}
            />
            <StatCard label="Deployments" value={data.counts.deployments} icon={<RocketLaunchOutlinedIcon />} onClick={() => navigate('/r/apps/v1/deployments')} />
            <StatCard
              label="Persistent Volumes"
              value={data.counts.persistentVolumesUnavailable ? '-' : data.counts.persistentVolumesBound}
              sub={
                data.counts.persistentVolumesUnavailable
                  ? 'unavailable'
                  : data.counts.persistentVolumes === data.counts.persistentVolumesBound
                    ? 'bound'
                    : `of ${data.counts.persistentVolumes} bound`
              }
              warn={!data.counts.persistentVolumesUnavailable && data.counts.persistentVolumesBound < data.counts.persistentVolumes}
              icon={<StorageOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/persistentvolumes')}
            />
            <StatCard
              label="CRDs"
              value={data.counts.crdsUnavailable ? '-' : data.counts.crdsEstablished}
              sub={data.counts.crdsUnavailable ? 'unavailable' : data.counts.crds === data.counts.crdsEstablished ? 'active' : `of ${data.counts.crds} active`}
              warn={!data.counts.crdsUnavailable && data.counts.crdsEstablished < data.counts.crds}
              icon={<ExtensionOutlinedIcon />}
              onClick={() => navigate('/r/apiextensions.k8s.io/v1/customresourcedefinitions')}
            />
            <StatCard
              label="Failing pods"
              value={data.failingPods.length}
              warn={data.failingPods.length > 0}
              icon={<ErrorOutlineIcon />}
              onClick={() => navigate('/r/core/v1/pods')}
            />
            <StatCard
              label="Warnings (1h)"
              value={data.warningEvents.length}
              warn={data.warningEvents.length > 0}
              icon={<WarningAmberOutlinedIcon />}
              onClick={() => navigate('/r/core/v1/events')}
            />
          </Grid>

          {data.counts.nodes > 0 && <NodeUsageCard nodeMetrics={nodeMetrics} />}

          {data.failingPods.length > 0 && (
            <ProblemCard title="Failing pods">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Pod</TableCell>
                    <TableCell>Reason</TableCell>
                    <TableCell>Restarts</TableCell>
                    <TableCell>Message</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.failingPods.map((p) => (
                    <TableRow key={`${p.namespace}/${p.name}`} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/r/core/v1/pods?sel=${ctx}|${p.namespace}|${p.name}`)}>
                      <TableCell>
                        {p.namespace}/{p.name}
                      </TableCell>
                      <TableCell>
                        <StatusChip status={p.reason} />
                      </TableCell>
                      <TableCell>{p.restarts}</TableCell>
                      <TableCell sx={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.message}>
                        {p.message ?? ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ProblemCard>
          )}

          {data.unavailableWorkloads.length > 0 && (
            <ProblemCard title="Unavailable workloads">
              <Stack direction="row" flexWrap="wrap" gap={1}>
                {data.unavailableWorkloads.map((w) => (
                  <Chip
                    key={`${w.namespace}/${w.name}`}
                    label={`${w.namespace}/${w.name} ${w.ready}/${w.desired}`}
                    color="warning"
                    variant="outlined"
                    onClick={() => navigate(`/r/apps/v1/deployments?sel=${ctx}|${w.namespace}|${w.name}`)}
                  />
                ))}
              </Stack>
            </ProblemCard>
          )}

          {data.recentRestarts.length > 0 && (
            <ProblemCard title="Recent restarts (1h)">
              <Stack direction="row" flexWrap="wrap" gap={1}>
                {data.recentRestarts.slice(0, 20).map((r) => (
                  <Chip key={`${r.namespace}/${r.pod}/${r.container}`} label={`${r.namespace}/${r.pod} ×${r.restarts}${r.reason ? ` (${r.reason})` : ''}`} variant="outlined" color="warning" />
                ))}
              </Stack>
            </ProblemCard>
          )}

          {data.warningEvents.length > 0 && (
            <ProblemCard title="Warning events (1h)">
              <Stack spacing={0.5}>
                {data.warningEvents.slice(0, 15).map((e, i) => (
                  <Typography key={i} variant="body2">
                    <Typography component="span" variant="body2" sx={{ color: 'warning.main', fontWeight: 600 }}>
                      {e.reason}
                    </Typography>
                    {e.count > 1 && (
                      <Typography component="span" variant="caption" sx={{ fontWeight: 600 }}>
                        {' '}({e.count}x)
                      </Typography>
                    )}{' '}
                    <Typography component="span" variant="caption" color="text.secondary">
                      <AgeCell timestamp={e.lastTimestamp} /> ago
                    </Typography>{' '}
                    — {e.involvedKind}/{e.namespace ? `${e.namespace}/` : ''}{e.involvedName}: {e.message}
                  </Typography>
                ))}
              </Stack>
            </ProblemCard>
          )}

          {data.failingPods.length === 0 && data.unavailableWorkloads.length === 0 && data.warningEvents.length === 0 && (
            <Alert severity="success" variant="outlined">
              No problems detected — all workloads healthy.
            </Alert>
          )}
        </>
      )}
    </Box>
  );
}

function NodeUsageCard({ nodeMetrics }: { nodeMetrics: ReturnType<typeof useNodeMetrics>['data'] }) {
  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Node usage
        </Typography>
        {!nodeMetrics && <LinearProgress />}
        {nodeMetrics && !nodeMetrics.available && (
          <Alert severity="info" variant="outlined">
            CPU and memory usage are unavailable. Install or repair metrics-server for this cluster.
          </Alert>
        )}
        {nodeMetrics?.available && nodeMetrics.items.length === 0 && (
          <Alert severity="info" variant="outlined">
            Waiting for node metrics.
          </Alert>
        )}
        {nodeMetrics?.available && nodeMetrics.items.length > 0 && (
          <Stack spacing={1}>
            {nodeMetrics.items.map((n) => (
              <Box key={n.name} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Typography variant="body2" sx={{ width: 220 }} noWrap>
                  {n.name}
                </Typography>
                <UsageBar label={`CPU ${formatCpu(n.cpuMilli)}`} pct={n.cpuCapacityMilli ? (n.cpuMilli / n.cpuCapacityMilli) * 100 : undefined} />
                <UsageBar label={`Mem ${formatBytes(n.memBytes)}`} pct={n.memCapacityBytes ? (n.memBytes / n.memCapacityBytes) * 100 : undefined} />
              </Box>
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function StatCard({
  label,
  value,
  sub,
  warn,
  icon,
  onClick,
}: {
  label: string;
  value: number | string;
  sub?: string;
  warn?: boolean;
  icon?: React.ReactElement;
  onClick?: () => void;
}) {
  return (
    <Grid size={{ xs: 6, sm: 4, md: 2 }}>
      <Card
        variant="outlined"
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={(event) => {
          if (!onClick) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick();
          }
        }}
        sx={(theme) => ({
          height: '100%',
          cursor: onClick ? 'pointer' : 'default',
          borderColor: warn ? 'warning.main' : undefined,
          transition: 'border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease',
          ...(onClick && {
            '&:hover': {
              borderColor: warn ? 'warning.main' : 'primary.main',
              transform: 'translateY(-1px)',
              boxShadow: `0 4px 14px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.35 : 0.08)}`,
            },
          }),
        })}
      >
        <CardContent sx={{ py: '12px !important', display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {icon && (
            <Box
              sx={(theme) => {
                const main = warn ? theme.palette.warning.main : theme.palette.primary.main;
                return {
                  width: 36,
                  height: 36,
                  borderRadius: 2,
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  color: main,
                  bgcolor: alpha(main, theme.palette.mode === 'dark' ? 0.14 : 0.08),
                  '& svg': { fontSize: 20 },
                };
              }}
            >
              {icon}
            </Box>
          )}
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              {label}
            </Typography>
            <Typography variant="h6" color={warn ? 'warning.main' : undefined} noWrap>
              {value}
              {sub && (
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  {sub}
                </Typography>
              )}
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Grid>
  );
}

function ProblemCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

function UsageBar({ label, pct }: { label: string; pct?: number }) {
  return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, pct ?? 0)}
        color={(pct ?? 0) > 90 ? 'error' : (pct ?? 0) > 75 ? 'warning' : 'primary'}
        sx={{ flex: 1, height: 6, borderRadius: 3 }}
      />
      <Typography variant="caption" sx={{ width: 130 }} color="text.secondary">
        {label}
        {pct !== undefined ? ` (${pct.toFixed(0)}%)` : ''}
      </Typography>
    </Box>
  );
}
