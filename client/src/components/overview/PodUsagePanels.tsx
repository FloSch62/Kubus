import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import type { PodResourceUsage } from '@kubus/shared';
import { usePodResources } from '../../api/queries.js';
import { useUiPrefsStore } from '../../state/prefs.js';
import { UsageMeter } from '../UsageMeter.js';
import { formatBytes, formatCpu } from '../format.js';
import { ProblemCard, kindListPath } from './cards.js';

const HIGH_USAGE_OPTIONS = [70, 80, 90];
const UNDER_REQUESTED_OPTIONS = [1.5, 2, 3];
const MAX_ROWS = 12;
// Ignore near-idle pods so tiny absolute overshoots don't flood the panels.
const CPU_FLOOR_MILLI = 20;
const MEM_FLOOR_BYTES = 32 * 1024 * 1024;

function highUsageScore(p: PodResourceUsage, pct: number): number {
  const cpu = p.cpuLimitMilli > 0 ? (p.cpuUsageMilli / p.cpuLimitMilli) * 100 : 0;
  const mem = p.memLimitBytes > 0 ? (p.memUsageBytes / p.memLimitBytes) * 100 : 0;
  const score = Math.max(cpu, mem);
  return score >= pct ? score : 0;
}

function underRequestedScore(p: PodResourceUsage, factor: number): number {
  const cpu = p.cpuRequestMilli > 0 && p.cpuUsageMilli >= CPU_FLOOR_MILLI ? p.cpuUsageMilli / p.cpuRequestMilli : 0;
  const mem = p.memRequestBytes > 0 && p.memUsageBytes >= MEM_FLOOR_BYTES ? p.memUsageBytes / p.memRequestBytes : 0;
  const score = Math.max(cpu, mem);
  return score >= factor ? score : 0;
}

/**
 * Threshold-driven pod panels: usage close to limits, and usage far above
 * requests (right-size candidates). Thresholds persist in UI prefs; filtering
 * is client-side so changing them never refetches.
 */
export function PodUsagePanels({ ctx, namespaces }: { ctx: string; namespaces?: string[] }) {
  const single = namespaces?.length === 1 ? namespaces[0] : undefined;
  const { data } = usePodResources(ctx, single);
  const highUsagePct = useUiPrefsStore((s) => s.highUsagePct);
  const underRequestedFactor = useUiPrefsStore((s) => s.underRequestedFactor);
  const setPrefs = useUiPrefsStore((s) => s.set);

  const pods = useMemo(() => {
    const all = data?.pods ?? [];
    if (!namespaces?.length || single) return all;
    const scope = new Set(namespaces);
    return all.filter((p) => scope.has(p.namespace));
  }, [data, namespaces, single]);

  const highUsage = useMemo(
    () =>
      pods
        .map((p) => ({ p, score: highUsageScore(p, highUsagePct) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ROWS),
    [pods, highUsagePct],
  );
  const underRequested = useMemo(
    () =>
      pods
        .map((p) => ({ p, score: underRequestedScore(p, underRequestedFactor) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ROWS),
    [pods, underRequestedFactor],
  );

  if (!data?.available) return null;

  return (
    <Grid container spacing={1.5} sx={{ mb: 0 }}>
      <Grid size={{ xs: 12, lg: 6 }}>
        <PodPanel
          ctx={ctx}
          hideNamespace={!!single}
          title="High usage pods"
          empty={`No pods above ${highUsagePct}% of their limits.`}
          entries={highUsage}
          maxOf={(p) => ({ cpu: p.cpuLimitMilli, mem: p.memLimitBytes })}
          maxHint="limit"
          action={
            <Select
              size="small"
              value={highUsagePct}
              onChange={(e) => setPrefs({ highUsagePct: Number(e.target.value) })}
              sx={{ fontSize: 13, '& .MuiSelect-select': { py: 0.25 } }}
            >
              {HIGH_USAGE_OPTIONS.map((v) => (
                <MenuItem key={v} value={v}>
                  ≥ {v}% of limit
                </MenuItem>
              ))}
            </Select>
          }
        />
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <PodPanel
          ctx={ctx}
          hideNamespace={!!single}
          title="Under-requested pods"
          empty={`No pods using ≥ ${underRequestedFactor}× their requests.`}
          entries={underRequested}
          maxOf={(p) => ({ cpu: p.cpuRequestMilli, mem: p.memRequestBytes })}
          maxHint="requested"
          action={
            <Select
              size="small"
              value={underRequestedFactor}
              onChange={(e) => setPrefs({ underRequestedFactor: Number(e.target.value) })}
              sx={{ fontSize: 13, '& .MuiSelect-select': { py: 0.25 } }}
            >
              {UNDER_REQUESTED_OPTIONS.map((v) => (
                <MenuItem key={v} value={v}>
                  ≥ {v}× requests
                </MenuItem>
              ))}
            </Select>
          }
        />
      </Grid>
    </Grid>
  );
}

function PodPanel({
  ctx,
  hideNamespace,
  title,
  empty,
  entries,
  maxOf,
  maxHint,
  action,
}: {
  ctx: string;
  hideNamespace?: boolean;
  title: string;
  empty: string;
  entries: Array<{ p: PodResourceUsage }>;
  maxOf: (p: PodResourceUsage) => { cpu: number; mem: number };
  maxHint: string;
  action: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <ProblemCard title={title} action={action}>
      {entries.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {empty}
        </Typography>
      )}
      {entries.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Pod</TableCell>
              <TableCell sx={{ width: '26%' }}>CPU</TableCell>
              <TableCell sx={{ width: '26%' }}>Memory</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.map(({ p }) => {
              const max = maxOf(p);
              return (
                <TableRow
                  key={`${p.namespace}/${p.name}`}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() =>
                    navigate(kindListPath({ group: '', version: 'v1', plural: 'pods' }, { sel: { ctx, namespace: p.namespace, name: p.name } }))
                  }
                >
                  <TableCell sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Box component="span" title={`${p.namespace}/${p.name}`}>
                      {hideNamespace ? p.name : `${p.namespace}/${p.name}`}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <UsageMeter value={p.cpuUsageMilli} max={max.cpu || undefined} format={formatCpu} maxHint={maxHint} placeholder />
                  </TableCell>
                  <TableCell>
                    <UsageMeter value={p.memUsageBytes} max={max.mem || undefined} format={formatBytes} maxHint={maxHint} placeholder />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </ProblemCard>
  );
}
