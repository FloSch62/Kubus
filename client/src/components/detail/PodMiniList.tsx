import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject, MetricsSnapshotEntry } from '@kubus/shared';
import { useMemo, useState } from 'react';
import { MiniFilterInput } from '../MiniFilterInput.js';
import { matchesPlainText, matchesSmartFilter, parseSmartFilter } from '../../smart-filter.js';
import { ReadyCounter } from '../ReadyCounter.js';
import { StatusChip } from '../StatusChip.js';
import { UsageMeter } from '../UsageMeter.js';
import { formatBytes, formatCpu } from '../format.js';
import { podRequestTotals, podSummary } from '../../kube-display.js';
import { useResourceMetrics } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';

/** Rows a mini list needs before it grows a filter box. */
const FILTER_THRESHOLD = 4;

/**
 * Compact clickable pod table used by Node, Service and Deployment detail
 * views. Past a handful of rows it grows the same filter the list pages
 * have: plain text, or `/status:crash restarts>2` smart clauses.
 */
export function PodMiniList({
  ctx,
  pods,
  title,
  loading,
  emptyText,
  hideNamespace,
}: {
  ctx: string;
  pods: KubeObject[];
  /** Optional heading; omit when the caller renders its own (e.g. a Section). */
  title?: string;
  loading?: boolean;
  emptyText?: string;
  /** Hide the namespace caption under pod names (single-namespace callers). */
  hideNamespace?: boolean;
}) {
  const push = useDetailStore((s) => s.push);
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const query = filter.trim();
    if (!query) return pods;
    const rows = pods.map((obj) => ({ ctx, obj }));
    if (query.startsWith('/')) {
      const clauses = parseSmartFilter(query.slice(1));
      const filterCtx = { kind: 'Pod', nowMs: Date.now() };
      return rows.filter((r) => matchesSmartFilter(r, clauses, filterCtx)).map((r) => r.obj);
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => matchesPlainText(r, words, 'Pod')).map((r) => r.obj);
  }, [pods, filter, ctx]);
  const showFilter = pods.length >= FILTER_THRESHOLD || !!filter;
  const metricsQuery = useResourceMetrics([ctx], 'pods');
  const usageByPod = useMemo(() => {
    const snap = metricsQuery.data?.get(ctx);
    if (!snap?.available) return undefined;
    return new Map<string, MetricsSnapshotEntry>(snap.items.map((i) => [`${i.namespace ?? ''}/${i.name}`, i]));
  }, [metricsQuery.data, ctx]);

  return (
    <Box>
      {title && (
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {title}
          {!loading && ` (${pods.length})`}
        </Typography>
      )}
      {!loading && showFilter && (
        <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
          <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter pods… / for smart filter" width={260} />
        </Box>
      )}
      {loading ? (
        <Box sx={{ p: 1.5 }}>
          <CircularProgress size={18} />
        </Box>
      ) : pods.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
          {emptyText ?? 'No pods.'}
        </Typography>
      ) : shown.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
          No pods match the filter.
        </Typography>
      ) : (
        <Table size="small" sx={{ '& th, & td': { px: 1 }, '& th:first-of-type, & td:first-of-type': { pl: 2 } }}>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Ready</TableCell>
              <TableCell>Status</TableCell>
              {usageByPod && <TableCell sx={{ minWidth: 96 }}>CPU</TableCell>}
              {usageByPod && <TableCell sx={{ minWidth: 96 }}>Memory</TableCell>}
              <TableCell>Restarts</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((pod) => {
              const summary = podSummary(pod);
              const usage = usageByPod?.get(`${pod.metadata.namespace ?? ''}/${pod.metadata.name}`);
              const requests = usage ? podRequestTotals(pod) : undefined;
              return (
                <TableRow
                  key={pod.metadata.uid}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace })}
                >
                  <TableCell sx={{ minWidth: 140, wordBreak: 'break-word' }} title={pod.metadata.name}>
                    {pod.metadata.name}
                    {!hideNamespace && pod.metadata.namespace && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {pod.metadata.namespace}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <ReadyCounter value={summary.ready} />
                  </TableCell>
                  <TableCell>
                    <StatusChip status={summary.status} />
                  </TableCell>
                  {usageByPod && (
                    <TableCell>
                      {usage ? <UsageMeter value={usage.cpuMilli} max={requests?.cpuMilli || undefined} format={formatCpu} placeholder emptyHint="no CPU requests set" /> : '—'}
                    </TableCell>
                  )}
                  {usageByPod && (
                    <TableCell>
                      {usage ? <UsageMeter value={usage.memBytes} max={requests?.memoryBytes || undefined} format={formatBytes} placeholder emptyHint="no memory requests set" /> : '—'}
                    </TableCell>
                  )}
                  <TableCell>{summary.restarts}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}
