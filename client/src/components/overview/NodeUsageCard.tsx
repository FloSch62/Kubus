import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Link as RouterLink } from 'react-router';
import type { MetricsSnapshot, MetricsSnapshotEntry } from '@kubus/shared';
import { statusTextColor } from '../../theme.js';
import { InstallMetricsServerButton } from '../MetricsServerControls.js';
import { formatBytes } from '../format.js';
import { ProblemCard, kindListPath } from './cards.js';

/** Node rows shown before "Show all N nodes". */
const INITIAL_NODES = 8;

const NODES = { group: '', version: 'v1', plural: 'nodes' };

export interface ClusterUsage {
  cpuMilli: number;
  memBytes: number;
  cpuCapacityMilli: number;
  memCapacityBytes: number;
}

/**
 * Summed usage against summed capacity. Capacity counts every node, also
 * the ones without a usage sample yet, so the total never overstates.
 */
export function clusterUsage(nodeMetrics: MetricsSnapshot | undefined): ClusterUsage | undefined {
  if (!nodeMetrics?.available || nodeMetrics.items.length === 0) return undefined;
  const sampled = nodeMetrics.items.reduce(
    (acc, item) => ({
      cpuMilli: acc.cpuMilli + item.cpuMilli,
      memBytes: acc.memBytes + item.memBytes,
      cpuCapacityMilli: acc.cpuCapacityMilli + (item.cpuCapacityMilli ?? 0),
      memCapacityBytes: acc.memCapacityBytes + (item.memCapacityBytes ?? 0),
    }),
    { cpuMilli: 0, memBytes: 0, cpuCapacityMilli: 0, memCapacityBytes: 0 },
  );
  return {
    ...sampled,
    cpuCapacityMilli: nodeMetrics.totalCpuCapacityMilli ?? sampled.cpuCapacityMilli,
    memCapacityBytes: nodeMetrics.totalMemCapacityBytes ?? sampled.memCapacityBytes,
  };
}

/** "7.44" / "8" / "500m": cores without trailing zeros, millicores below one core. */
function cores(milli: number): string {
  return milli < 1000 ? `${milli}m` : String(Number((milli / 1000).toFixed(2)));
}

/** "7.44 / 8 cores", "500m / 2 cores". */
function cpuPair(used: number, capacity: number | undefined, sep: string): string {
  if (!capacity) return used < 1000 ? `${used}m` : `${cores(used)} cores`;
  return `${cores(used)}${sep}${cores(capacity)}${capacity < 1000 ? '' : ' cores'}`;
}

/** "31.0 / 32.0Gi": the unit once when both sides share it. */
function bytesPair(used: number, capacity: number | undefined, sep: string): string {
  const u = formatBytes(used);
  if (!capacity) return u;
  const c = formatBytes(capacity);
  const unit = /[A-Za-z]+$/.exec(c)?.[0] ?? '';
  return u.endsWith(unit) && unit ? `${u.slice(0, -unit.length)}${sep}${c}` : `${u}${sep}${c}`;
}

const pctOf = (used: number, capacity: number | undefined) => (capacity ? (used / capacity) * 100 : undefined);

/** Busiest resource of a node, for ordering the rows. */
const peak = (n: MetricsSnapshotEntry) => Math.max(pctOf(n.cpuMilli, n.cpuCapacityMilli) ?? 0, pctOf(n.memBytes, n.memCapacityBytes) ?? 0);

const barColor = (pct: number | undefined) => ((pct ?? 0) > 90 ? 'error' : (pct ?? 0) > 75 ? 'warning' : 'primary');
const pctTone = (pct: number | undefined) => ((pct ?? 0) > 90 ? 'error' : (pct ?? 0) > 75 ? 'warning' : undefined);

/**
 * CPU and memory in use across the cluster: the total as two large meters,
 * then one row per node, busiest first. With a single node the meters are
 * that node. Covers the states before usage exists: the first probe still
 * running, metrics-server missing (with the install action), no sample yet.
 */
export function NodeUsageCard({ ctx, nodes, nodeMetrics }: { ctx: string; nodes: number; nodeMetrics: MetricsSnapshot | undefined }) {
  const [showAll, setShowAll] = useState(false);
  const total = useMemo(() => clusterUsage(nodeMetrics), [nodeMetrics]);
  const rows = useMemo(() => [...(nodeMetrics?.items ?? [])].sort((a, b) => peak(b) - peak(a) || a.name.localeCompare(b.name)), [nodeMetrics]);
  const single = nodes <= 1 && rows.length <= 1;
  const shown = showAll ? rows : rows.slice(0, INITIAL_NODES);

  return (
    <ProblemCard
      title="Node usage"
      count={nodes}
      anchor="node-usage"
      description={
        total && single && rows[0] ? (
          <NodeLink ctx={ctx} name={rows[0].name} variant="caption" />
        ) : total && rows.length < nodes ? (
          `${rows.length} of ${nodes} nodes reporting`
        ) : undefined
      }
      action={
        <Link component={RouterLink} to="/metrics" underline="hover" variant="caption" sx={{ display: 'inline-flex', alignItems: 'center', fontWeight: 600 }}>
          Usage over time
          <ChevronRightIcon sx={{ fontSize: 16, mr: -0.5 }} />
        </Link>
      }
    >
      {!nodeMetrics?.probed ? (
        <UsageSkeleton rows={single ? 0 : Math.min(nodes, 3)} />
      ) : !nodeMetrics.available ? (
        <Alert severity="info" variant="outlined" sx={{ alignItems: 'center' }} action={<InstallMetricsServerButton ctx={ctx} />}>
          CPU and memory usage are unavailable because metrics-server is not serving data in this cluster.
        </Alert>
      ) : !total ? (
        <Typography variant="body2" color="text.secondary">
          Waiting for the first node metrics sample.
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 4, rowGap: 2 }}>
            <TotalMeter label="CPU" used={total.cpuMilli} capacity={total.cpuCapacityMilli} pair={cpuPair} />
            <TotalMeter label="Memory" used={total.memBytes} capacity={total.memCapacityBytes} pair={bytesPair} />
          </Box>
          {!single && (
            <Box sx={{ mt: 2, mx: -1.5, mb: -1.5, borderTop: 1, borderColor: 'divider', overflowX: 'auto' }}>
              <Table size="small" aria-label="Usage per node" sx={{ tableLayout: 'fixed', minWidth: 560, '& .MuiTableCell-root': { px: 1.5 } }}>
                <colgroup>
                  <col style={{ width: '28%' }} />
                  <col />
                  <col />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell>Node</TableCell>
                    <TableCell>CPU</TableCell>
                    <TableCell>Memory</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.map((n) => (
                    <TableRow key={n.name} sx={{ '&:last-child .MuiTableCell-body': { borderBottom: rows.length > INITIAL_NODES ? undefined : 0 } }}>
                      <TableCell>
                        <NodeLink ctx={ctx} name={n.name} />
                      </TableCell>
                      <UsageCell used={n.cpuMilli} capacity={n.cpuCapacityMilli} pair={cpuPair} label="CPU" />
                      <UsageCell used={n.memBytes} capacity={n.memCapacityBytes} pair={bytesPair} label="Memory" />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rows.length > INITIAL_NODES && (
                <Box sx={{ px: 1, py: 0.5 }}>
                  <Button size="small" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                    {showAll ? 'Show fewer' : `Show all ${rows.length} nodes`}
                  </Button>
                </Box>
              )}
            </Box>
          )}
        </>
      )}
    </ProblemCard>
  );
}

function NodeLink({ ctx, name, variant = 'body2' }: { ctx: string; name: string; variant?: 'body2' | 'caption' }) {
  return (
    <Link
      component={RouterLink}
      to={kindListPath(NODES, { sel: { ctx, name } })}
      underline="hover"
      variant={variant}
      noWrap
      title={name}
      sx={{ fontWeight: 600, minWidth: 0, display: 'block' }}
    >
      {name}
    </Link>
  );
}

type Pair = (used: number, capacity: number | undefined, sep: string) => string;

/** Large meter for the cluster total: percentage, bar, "used of capacity". */
function TotalMeter({ label, used, capacity, pair }: { label: string; used: number; capacity: number; pair: Pair }) {
  const pct = pctOf(used, capacity);
  const tone = pctTone(pct);
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.75 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography
          component="span"
          sx={{ ml: 'auto', fontSize: 22, fontWeight: 650, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: tone ? statusTextColor(tone) : 'text.primary' }}
        >
          {pct !== undefined ? `${pct.toFixed(0)}%` : pair(used, undefined, '')}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, pct ?? 0)}
        color={barColor(pct)}
        aria-label={`${label} ${pct !== undefined ? `${pct.toFixed(0)}% used` : 'in use'}`}
        sx={{ height: 8, borderRadius: 4 }}
      />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>
        {capacity > 0 ? `${pair(used, capacity, ' of ')} in use` : `${pair(used, undefined, '')} in use, capacity unknown`}
      </Typography>
    </Box>
  );
}

function UsageCell({ used, capacity, pair, label }: { used: number; capacity: number | undefined; pair: Pair; label: string }) {
  const pct = pctOf(used, capacity);
  const tone = pctTone(pct);
  const text = pair(used, capacity, ' / ');
  return (
    <TableCell>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
        <LinearProgress
          variant="determinate"
          value={Math.min(100, pct ?? 0)}
          color={barColor(pct)}
          aria-label={`${label} ${text}`}
          sx={{ flex: 1, minWidth: 48, height: 6, borderRadius: 3 }}
        />
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          <Box component="span" sx={{ display: 'inline-block', minWidth: '15ch' }}>
            {text}
          </Box>
          {pct !== undefined && (
            <Box component="span" sx={{ display: 'inline-block', minWidth: '4.5ch', fontWeight: 600, color: tone ? statusTextColor(tone) : 'text.primary' }}>
              {` ${pct.toFixed(0)}%`}
            </Box>
          )}
        </Typography>
      </Box>
    </TableCell>
  );
}

/** Content-shaped placeholder while the first metrics probe runs. */
function UsageSkeleton({ rows }: { rows: number }) {
  return (
    <Box aria-busy="true" aria-label="Loading node usage">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', columnGap: 4, rowGap: 2 }}>
        {[0, 1].map((i) => (
          <Box key={i}>
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="rounded" height={8} sx={{ my: 0.75 }} />
            <Skeleton variant="text" width="55%" />
          </Box>
        ))}
      </Box>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} variant="rounded" height={22} sx={{ mt: i === 0 ? 2 : 1 }} />
      ))}
    </Box>
  );
}
