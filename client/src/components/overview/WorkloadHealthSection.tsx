import { useMemo } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router';
import { pluralLabel, type OverviewKindHealth, type OverviewWorkloadIssue } from '@kubus/shared';
import { StatusChip } from '../StatusChip.js';
import { ProblemCard, kindListPath } from './cards.js';

/**
 * Unified workload health: one tile per kind (Deployments … ResourceQuotas)
 * linking to its list, plus the issues behind the unhealthy counts. List
 * links inherit the global namespace filter, so a scoped overview lands on
 * equally scoped lists.
 */
export function WorkloadHealthSection({
  ctx,
  health,
  issues,
  scoped,
  hideNamespace,
}: {
  ctx: string;
  health: OverviewKindHealth[];
  issues: OverviewWorkloadIssue[];
  /** Namespace-scoped view: hide kinds with nothing in scope. */
  scoped?: boolean;
  /** Single-namespace scope: the prefix would repeat on every row. */
  hideNamespace?: boolean;
}) {
  const navigate = useNavigate();
  const gvrByKind = useMemo(() => new Map(health.map((h) => [h.kind, h])), [health]);
  // Scoped view: the inventory card already shows per-kind counts, so this
  // section reduces to the issue list.
  if (scoped && issues.length === 0) return null;

  return (
    <ProblemCard title="Workload health">
      {!scoped && (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {health.map((h) => (
          <ButtonBase
            key={h.kind}
            onClick={() => navigate(kindListPath(h))}
            sx={{
              px: 1.25,
              py: 0.75,
              border: 1,
              borderColor: h.unhealthy > 0 ? 'warning.main' : 'divider',
              borderRadius: 1.5,
              display: 'flex',
              alignItems: 'baseline',
              gap: 0.75,
              '&:hover': { bgcolor: 'action.hover', borderColor: h.unhealthy > 0 ? 'warning.main' : 'primary.main' },
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {pluralLabel(h.kind)}
            </Typography>
            {h.unavailable ? (
              <Typography variant="body2" color="text.disabled" title="Resource API unavailable on this cluster">
                —
              </Typography>
            ) : (
              <>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {h.total}
                </Typography>
                {h.unhealthy > 0 && (
                  <Typography variant="body2" sx={{ fontWeight: 700, color: 'warning.main' }}>
                    {h.unhealthy} unhealthy
                  </Typography>
                )}
              </>
            )}
          </ButtonBase>
        ))}
      </Box>
      )}
      {issues.length > 0 && (
        <Table size="small" sx={{ mt: scoped ? 0 : 1 }}>
          <TableHead>
            <TableRow>
              <TableCell>Kind</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Ready</TableCell>
              <TableCell>Detail</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {issues.map((w) => {
              const gvr = gvrByKind.get(w.kind);
              return (
                <TableRow
                  key={`${w.kind}/${w.namespace}/${w.name}`}
                  hover={!!gvr}
                  sx={{ cursor: gvr ? 'pointer' : 'default' }}
                  onClick={() => gvr && navigate(kindListPath(gvr, { sel: { ctx, namespace: w.namespace || undefined, name: w.name } }))}
                >
                  <TableCell>{w.kind}</TableCell>
                  <TableCell>
                    {w.namespace && !hideNamespace ? `${w.namespace}/` : ''}
                    {w.name}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={w.reason ?? 'Unhealthy'} />
                  </TableCell>
                  <TableCell>{w.ready !== undefined && w.desired !== undefined ? `${w.ready}/${w.desired}` : ''}</TableCell>
                  <TableCell sx={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.message}>
                    {w.message ?? ''}
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
