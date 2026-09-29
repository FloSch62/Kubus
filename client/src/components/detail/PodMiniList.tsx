import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { KubeObject, MetricsSnapshotEntry } from '@kubus/shared';
import { useMemo, useState, type MouseEvent } from 'react';
import { MiniFilterInput } from '../MiniFilterInput.js';
import { matchesPlainText, matchesSmartFilter, parseSmartFilter } from '../../smart-filter.js';
import { ReadyCounter } from '../ReadyCounter.js';
import { StatusChip } from '../StatusChip.js';
import { UsageMeter } from '../UsageMeter.js';
import { formatBytes, formatCpu } from '../format.js';
import { podRequestTotals, podSummary } from '../../kube-display.js';
import { useResourceMetrics } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';
import { statusTextColor } from '../../theme.js';
import { quotaNamesIn } from './quota-link.js';
import { podSchedulingIssue, type SchedulingIssue } from './scheduling.js';
import { naturalCompare } from '../natural-sort.js';

/** Rows a mini list needs before it grows a filter box. */
const FILTER_THRESHOLD = 4;

type OwnerFilter = 'all' | 'daemonset' | 'other';

/** The DaemonSet controlling a pod, if any. */
export function daemonSetOwner(pod: KubeObject): string | undefined {
  return (pod.metadata.ownerReferences ?? []).find((o) => o.kind === 'DaemonSet' && o.controller)?.name;
}

/**
 * Compact clickable pod table used by Node, Service and workload detail
 * views. Past a handful of rows it grows the same filter the list pages
 * have: plain text, or `/status:crash restarts>2` smart clauses. A pod no
 * node will take says why under its status.
 */
export function PodMiniList({
  ctx,
  pods,
  title,
  loading,
  emptyText,
  hideNamespace,
  issues,
  showNode,
  daemonSets,
}: {
  ctx: string;
  pods: KubeObject[];
  /** Optional heading; omit when the caller renders its own (e.g. a Section). */
  title?: string;
  loading?: boolean;
  emptyText?: string;
  /** Hide the namespace caption under pod names (single-namespace callers). */
  hideNamespace?: boolean;
  /** Scheduling problems by pod uid, when the caller has read events too; otherwise the pods' own conditions are used. */
  issues?: Map<string, SchedulingIssue>;
  /** Name each pod's node under it (DaemonSet pods, where the node is the pod's identity). */
  showNode?: boolean;
  /** Mark DaemonSet pods and offer a filter between them and the rest (a node's pods). */
  daemonSets?: boolean;
}) {
  const push = useDetailStore((s) => s.push);
  const [filter, setFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const daemonCount = useMemo(() => (daemonSets ? pods.filter((p) => daemonSetOwner(p)).length : 0), [pods, daemonSets]);
  // With no DaemonSet pods left the chips vanish, so their filter must too.
  const owner: OwnerFilter = daemonCount > 0 ? ownerFilter : 'all';
  // Natural order, like the list pages: web-2 before web-10.
  const sorted = useMemo(
    () => [...pods].sort((a, b) => naturalCompare(a.metadata.namespace ?? '', b.metadata.namespace ?? '') || naturalCompare(a.metadata.name, b.metadata.name)),
    [pods],
  );
  const shown = useMemo(() => {
    const byOwner = owner === 'all' ? sorted : sorted.filter((p) => !!daemonSetOwner(p) === (owner === 'daemonset'));
    const query = filter.trim();
    if (!query) return byOwner;
    const rows = byOwner.map((obj) => ({ ctx, obj }));
    if (query.startsWith('/')) {
      const clauses = parseSmartFilter(query.slice(1));
      const filterCtx = { kind: 'Pod', nowMs: Date.now() };
      return rows.filter((r) => matchesSmartFilter(r, clauses, filterCtx)).map((r) => r.obj);
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => matchesPlainText(r, words, 'Pod')).map((r) => r.obj);
  }, [sorted, filter, ctx, owner]);
  const showFilter = pods.length >= FILTER_THRESHOLD || !!filter;
  const metricsQuery = useResourceMetrics([ctx], 'pods');
  const usageByPod = useMemo(() => {
    const snap = metricsQuery.data?.get(ctx);
    if (!snap?.available) return undefined;
    return new Map<string, MetricsSnapshotEntry>(snap.items.map((i) => [`${i.namespace ?? ''}/${i.name}`, i]));
  }, [metricsQuery.data, ctx]);

  const openNode = (e: MouseEvent, name: string) => {
    e.stopPropagation();
    push({ ctx, group: '', version: 'v1', plural: 'nodes', kind: 'Node', name });
  };
  const openQuota = (e: MouseEvent, name: string, namespace: string | undefined) => {
    e.stopPropagation();
    push({ ctx, group: '', version: 'v1', plural: 'resourcequotas', kind: 'ResourceQuota', name, namespace });
  };
  const ownerChips: Array<{ value: OwnerFilter; label: string }> = [
    { value: 'all', label: `All ${pods.length}` },
    { value: 'daemonset', label: `DaemonSet ${daemonCount}` },
    { value: 'other', label: `Other ${pods.length - daemonCount}` },
  ];

  return (
    <Box>
      {title && (
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {title}
          {!loading && ` (${pods.length})`}
        </Typography>
      )}
      {!loading && (showFilter || daemonCount > 0) && (
        <Stack direction="row" sx={{ px: 1.5, pt: 1, pb: 0.5, gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          {showFilter && <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter pods… / for smart filter" width={260} />}
          {daemonCount > 0 && (
            <Stack direction="row" sx={{ gap: 0.5 }}>
              {ownerChips.map((chip) => (
                <Chip
                  key={chip.value}
                  size="small"
                  label={chip.label}
                  color={owner === chip.value ? 'primary' : 'default'}
                  variant={owner === chip.value ? 'filled' : 'outlined'}
                  aria-pressed={owner === chip.value}
                  onClick={() => setOwnerFilter(chip.value)}
                  sx={{ height: 24, fontSize: 12 }}
                />
              ))}
            </Stack>
          )}
        </Stack>
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
              const issue = issues ? issues.get(pod.metadata.uid) : podSchedulingIssue(pod);
              const daemonSet = daemonSets ? daemonSetOwner(pod) : undefined;
              const node = summary.node ?? (showNode ? issue?.node : undefined);
              return (
                <TableRow
                  key={pod.metadata.uid}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace })}
                >
                  <TableCell sx={{ minWidth: 140, wordBreak: 'break-word' }} title={pod.metadata.name}>
                    {pod.metadata.name}
                    {daemonSet && (
                      <Tooltip title={`Managed by DaemonSet ${daemonSet}`}>
                        <Box
                          component="span"
                          sx={{ ml: 0.75, px: 0.5, py: 0.125, borderRadius: 0.75, fontSize: 10.5, fontWeight: 600, lineHeight: 1.5, bgcolor: 'action.hover', color: 'text.secondary', whiteSpace: 'nowrap' }}
                        >
                          DS
                        </Box>
                      </Tooltip>
                    )}
                    {!hideNamespace && pod.metadata.namespace && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {pod.metadata.namespace}
                      </Typography>
                    )}
                    {showNode && node && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {'on '}
                        <Link component="button" variant="caption" underline="hover" onClick={(e) => openNode(e, node)} sx={{ textAlign: 'left', verticalAlign: 'baseline', wordBreak: 'break-all' }}>
                          {node}
                        </Link>
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <ReadyCounter value={summary.ready} />
                  </TableCell>
                  <TableCell sx={issue ? { minWidth: 130 } : undefined}>
                    <StatusChip status={summary.status} />
                    {issue && (
                      <Tooltip title={issue.message}>
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.25, color: statusTextColor('warning'), lineHeight: 1.35, wordBreak: 'break-word' }}>
                          {issue.short}
                          {issue.node && !showNode && (
                            <>
                              {' on '}
                              <Link component="button" variant="caption" onClick={(e) => openNode(e, issue.node!)} sx={{ verticalAlign: 'baseline', color: 'inherit' }}>
                                {issue.node}
                              </Link>
                            </>
                          )}
                          {quotaNamesIn(issue.message).map((quota) => (
                            <Link key={quota} component="button" variant="caption" onClick={(e) => openQuota(e, quota, pod.metadata.namespace)} sx={{ ml: 0.75, verticalAlign: 'baseline', color: 'inherit' }}>
                              quota {quota}
                            </Link>
                          ))}
                        </Typography>
                      </Tooltip>
                    )}
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
