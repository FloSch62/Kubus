import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { memo, useMemo, useState, type MouseEvent } from 'react';
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

/**
 * Rows rendered before "Show all": a node-exporter DaemonSet on a thousand
 * nodes would otherwise lay out a thousand rows on every poll.
 */
export const POD_ROW_LIMIT = 50;

const HEALTHY_STATES = new Set(['Running', 'Succeeded', 'Completed']);

/** Pods worth seeing first when the list is cut short: not running, or not ready. */
function needsAttention(pod: KubeObject): boolean {
  const summary = podSummary(pod);
  if (!HEALTHY_STATES.has(summary.status)) return true;
  const [ready, total] = summary.ready.split('/');
  return summary.status === 'Running' && ready !== total;
}

type OwnerFilter = 'all' | 'daemonset' | 'other';

interface FailedPodShape {
  phase?: string;
  reason?: string;
  message?: string;
  containerStatuses?: Array<{ name: string; state?: { terminated?: { exitCode?: number; reason?: string; message?: string } } }>;
  initContainerStatuses?: FailedPodShape['containerStatuses'];
}

/**
 * Why a Failed pod stopped, for a caption under its status: the pod-level
 * reason (Evicted, DeadlineExceeded) or the first container that exited
 * badly. Undefined for pods that have not failed.
 */
export function podFailure(pod: KubeObject): { short: string; message?: string } | undefined {
  const status = pod.status as FailedPodShape | undefined;
  if (status?.phase !== 'Failed') return undefined;
  if (status.message) {
    // "The node was low on resource: memory. Threshold quantity: …" → its first sentence.
    const first = /^.*?[.!?](?=\s|$)/.exec(status.message.trim())?.[0] ?? status.message.trim();
    return { short: first, message: status.message };
  }
  for (const cs of [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])]) {
    const t = cs.state?.terminated;
    if (!t?.exitCode) continue;
    if (t.reason === 'OOMKilled') return { short: `${cs.name} ran out of memory (OOMKilled)`, message: 'It used more memory than its limit allows.' };
    if (t.exitCode === 137) return { short: `${cs.name} was killed (exit 137, SIGKILL)`, message: t.message ?? 'Exit 137 usually means the out-of-memory killer or a failed liveness probe.' };
    if (t.exitCode === 143) return { short: `${cs.name} was stopped (exit 143, SIGTERM)`, message: t.message };
    return { short: `${cs.name} exited with code ${t.exitCode}${t.reason && t.reason !== 'Error' ? ` (${t.reason})` : ''}`, message: t.message };
  }
  return status.reason ? { short: status.reason } : undefined;
}

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
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
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

  // Cut short, the list leads with the pods that need attention so none of
  // them hides behind "Show all"; otherwise it keeps its natural order.
  const truncated = !showAll && shown.length > POD_ROW_LIMIT;
  const visible = useMemo(() => {
    if (!truncated) return shown;
    const attention = shown.filter(needsAttention);
    const rest = shown.filter((p) => !needsAttention(p));
    return [...attention, ...rest].slice(0, POD_ROW_LIMIT);
  }, [shown, truncated]);
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
            {visible.map((pod) => (
              <PodRow
                key={pod.metadata.uid}
                ctx={ctx}
                pod={pod}
                showUsage={!!usageByPod}
                usage={usageByPod?.get(`${pod.metadata.namespace ?? ''}/${pod.metadata.name}`)}
                issue={issues ? issues.get(pod.metadata.uid) : undefined}
                ownIssue={!issues}
                daemonSet={daemonSets ? daemonSetOwner(pod) : undefined}
                hideNamespace={hideNamespace}
                showNode={showNode}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {!loading && truncated && (
        <Stack direction="row" sx={{ px: 2, py: 1, gap: 1.5, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary">
            {`Showing ${POD_ROW_LIMIT} of ${shown.length} pods, those needing attention first.`}
          </Typography>
          <Button size="small" onClick={() => setShowAll(true)} sx={{ py: 0, minWidth: 0 }}>
            {`Show all ${shown.length}`}
          </Button>
        </Stack>
      )}
    </Box>
  );
}

/**
 * One pod row. Memoized: list polls keep unchanged pods' object identity,
 * so only the rows whose pod, usage or issue changed render again.
 */
const PodRow = memo(function PodRow({
  ctx,
  pod,
  showUsage,
  usage,
  issue: givenIssue,
  ownIssue,
  daemonSet,
  hideNamespace,
  showNode,
}: {
  ctx: string;
  pod: KubeObject;
  showUsage: boolean;
  usage?: MetricsSnapshotEntry;
  issue?: SchedulingIssue;
  /** No caller-supplied issues: read the pod's own scheduling condition. */
  ownIssue: boolean;
  daemonSet?: string;
  hideNamespace?: boolean;
  showNode?: boolean;
}) {
  const push = useDetailStore((s) => s.push);
  const summary = podSummary(pod);
  const requests = usage ? podRequestTotals(pod) : undefined;
  const issue = ownIssue ? podSchedulingIssue(pod) : givenIssue;
  const failure = podFailure(pod);
  const node = summary.node ?? (showNode ? issue?.node : undefined);
  const openNode = (e: MouseEvent, name: string) => {
    e.stopPropagation();
    push({ ctx, group: '', version: 'v1', plural: 'nodes', kind: 'Node', name });
  };
  const openQuota = (e: MouseEvent, name: string) => {
    e.stopPropagation();
    push({ ctx, group: '', version: 'v1', plural: 'resourcequotas', kind: 'ResourceQuota', name, namespace: pod.metadata.namespace });
  };
  return (
    <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace })}>
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
      <TableCell sx={issue || failure ? { minWidth: 130 } : undefined}>
        <StatusChip status={summary.status} />
        {failure && (
          <Tooltip title={failure.message ?? ''}>
            <Typography variant="caption" sx={{ display: 'block', mt: 0.25, color: statusTextColor('error'), lineHeight: 1.35, wordBreak: 'break-word' }}>
              {failure.short}
            </Typography>
          </Tooltip>
        )}
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
                <Link key={quota} component="button" variant="caption" onClick={(e) => openQuota(e, quota)} sx={{ ml: 0.75, verticalAlign: 'baseline', color: 'inherit' }}>
                  quota {quota}
                </Link>
              ))}
            </Typography>
          </Tooltip>
        )}
      </TableCell>
      {showUsage && (
        <TableCell>
          {usage ? <UsageMeter value={usage.cpuMilli} max={requests?.cpuMilli || undefined} format={formatCpu} placeholder emptyHint="no CPU requests set" /> : '—'}
        </TableCell>
      )}
      {showUsage && (
        <TableCell>
          {usage ? <UsageMeter value={usage.memBytes} max={requests?.memoryBytes || undefined} format={formatBytes} placeholder emptyHint="no memory requests set" /> : '—'}
        </TableCell>
      )}
      <TableCell>{summary.restarts}</TableCell>
    </TableRow>
  );
});
