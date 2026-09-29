import { Fragment, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useNavigate } from 'react-router';
import { pluralLabel, type OverviewKindHealth, type OverviewWorkloadIssue } from '@kubus/shared';
import { useClustersStore } from '../../state/clusters.js';
import { statusTextColor } from '../../theme.js';
import { ProblemCard, kindListPath } from './cards.js';
import { describeIssue, issueTone } from './issue-cause.js';

/** Rows shown before "Show N more". */
const INITIAL_ROWS = 8;

/**
 * List link for a kind narrowed to what is broken, and to this cluster when
 * several are selected (lists show every selected cluster).
 */
export function unhealthyListPath(gvr: { group: string; version: string; plural: string }, ctx: string, multiCluster: boolean): string {
  // The leading slash puts the list's filter in smart-filter mode.
  const q = multiCluster ? `/cluster:${ctx} status:unhealthy` : '/status:unhealthy';
  return `${kindListPath(gvr)}?q=${encodeURIComponent(q)}`;
}

/**
 * Every unhealthy object across workload, autoscaling, storage and policy
 * kinds, with the concrete reason behind it: the pods' own state, the
 * scheduler's answer or the controller's refusal. The header sums it up per
 * kind ("Deployments 3/18"), each linking to that list narrowed to the
 * broken ones. Nothing to show means no card: the attention row already
 * says everything is healthy.
 */
export function WorkloadHealthSection({
  ctx,
  health,
  issues,
  hideNamespace,
}: {
  ctx: string;
  health: OverviewKindHealth[];
  issues: OverviewWorkloadIssue[];
  /** Single-namespace scope: the namespace would repeat on every row. */
  hideNamespace?: boolean;
}) {
  const navigate = useNavigate();
  const multiCluster = useClustersStore((s) => s.selected.length > 1);
  const [expanded, setExpanded] = useState(false);
  const gvrByKind = useMemo(() => new Map(health.map((h) => [h.kind, h])), [health]);
  if (issues.length === 0) return null;
  const unhealthyKinds = health.filter((h) => h.unhealthy > 0);
  const rows = expanded ? issues : issues.slice(0, INITIAL_ROWS);

  return (
    <ProblemCard
      anchor="unhealthy-workloads"
      title="Unhealthy workloads"
      count={issues.length}
      flush
      action={
        <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 0.5, rowGap: 0.25, justifyContent: 'flex-end' }}>
          {unhealthyKinds.map((h, i) => (
            <Fragment key={h.kind}>
              {i > 0 && <span aria-hidden>·</span>}
              <Link
                component={RouterLink}
                to={unhealthyListPath(h, ctx, multiCluster)}
                underline="hover"
                variant="caption"
                title={`Show the unhealthy ${pluralLabel(h.kind)}`}
                sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}
              >
                {pluralLabel(h.kind)} {h.unhealthy}/{h.total}
              </Link>
            </Fragment>
          ))}
        </Typography>
      }
    >
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Workload</TableCell>
            <TableCell sx={{ width: 64 }}>Ready</TableCell>
            <TableCell>Reason</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((w) => {
            const gvr = gvrByKind.get(w.kind);
            const to = gvr ? kindListPath(gvr, { sel: { ctx, namespace: w.namespace || undefined, name: w.name } }) : undefined;
            const reason = describeIssue(w);
            const tone = issueTone(w);
            return (
              <TableRow
                key={`${w.kind}/${w.namespace}/${w.name}`}
                hover={!!to}
                sx={{ cursor: to ? 'pointer' : 'default', verticalAlign: 'top' }}
                onClick={() => to && navigate(to)}
              >
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 0.75 }}>
                    {w.kind}
                  </Typography>
                  {to ? (
                    <Link component={RouterLink} to={to} underline="hover" onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 600 }}>
                      {w.name}
                    </Link>
                  ) : (
                    <Box component="span" sx={{ fontWeight: 600 }}>
                      {w.name}
                    </Box>
                  )}
                  {w.namespace && !hideNamespace && (
                    <Typography component="span" variant="caption" color="text.disabled" sx={{ ml: 0.75 }}>
                      {w.namespace}
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {w.ready !== undefined && w.desired !== undefined ? (
                    <Box component="span" sx={{ fontWeight: 600, color: statusTextColor(tone) }}>
                      {w.ready}/{w.desired}
                    </Box>
                  ) : (
                    <Typography component="span" variant="body2" color="text.disabled">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{ minWidth: 260, overflowWrap: 'anywhere' }} title={reason.full}>
                  <span className={`kubus-status kubus-status-${tone}`}>
                    <span className="kubus-status-dot" aria-hidden="true" />
                    {reason.status}
                  </span>
                  {reason.detail && (
                    <Typography component="span" variant="body2" color="text.secondary">
                      {' · '}
                      {reason.detail}
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {issues.length > INITIAL_ROWS && (
            <TableRow>
              <TableCell colSpan={3} sx={{ py: 0.5 }}>
                <Button size="small" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Show fewer' : `Show ${issues.length - INITIAL_ROWS} more`}
                </Button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </ProblemCard>
  );
}
