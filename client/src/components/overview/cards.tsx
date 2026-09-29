import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useNavigate } from 'react-router';
import { gvkForKind, type OverviewProblemPod, type OverviewWarningEvent } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { CountPill } from '../detail/Section.js';
import { StatusChip } from '../StatusChip.js';
import { useApiResources } from '../../api/queries.js';
import { kindListPath } from '../../resource-links.js';
import { statusTextColor } from '../../theme.js';

export { kindListPath };

export function FailingPodsCard({ ctx, pods, hideNamespace }: { ctx: string; pods: OverviewProblemPod[]; hideNamespace?: boolean }) {
  const navigate = useNavigate();
  if (pods.length === 0) return null;
  return (
    <ProblemCard title="Failing pods" count={pods.length} flush>
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
          {pods.map((p) => (
            <TableRow
              key={`${p.namespace}/${p.name}`}
              hover
              sx={{ cursor: 'pointer' }}
              onClick={() =>
                navigate(kindListPath({ group: '', version: 'v1', plural: 'pods' }, { sel: { ctx, namespace: p.namespace || undefined, name: p.name } }))
              }
            >
              <TableCell>{hideNamespace ? p.name : `${p.namespace}/${p.name}`}</TableCell>
              <TableCell>
                <StatusChip status={p.reason} />
              </TableCell>
              <TableCell>{p.restarts}</TableCell>
              <TableCell sx={{ minWidth: 240, maxWidth: 560, overflowWrap: 'anywhere', color: 'text.secondary' }}>{p.message ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ProblemCard>
  );
}

export function WarningEventsCard({ ctx, events }: { ctx: string; events: OverviewWarningEvent[] }) {
  const { data: apiResources } = useApiResources(events.length > 0 ? ctx : undefined);
  if (events.length === 0) return null;
  // Server-side resolution can miss (payload from an older server, discovery
  // hiccup); fall back to the builtin table, then the cached discovery list.
  const kindFromDiscovery = (kind: string) => {
    const byKind = apiResources?.filter((k) => k.kind === kind) ?? [];
    return byKind.find((k) => !k.custom) ?? byKind[0];
  };
  return (
    <ProblemCard title="Warning events (1h)" count={events.length}>
      <Stack spacing={0.5}>
        {events.slice(0, 15).map((e) => {
          const gvr = e.involvedGvr ?? gvkForKind(e.involvedKind) ?? kindFromDiscovery(e.involvedKind);
          const namespace = gvr?.namespaced === false ? undefined : e.namespace || undefined;
          const label = `${e.involvedKind}/${namespace ? `${namespace}/` : ''}${e.involvedName}`;
          return (
            <Typography key={`${e.namespace}/${e.involvedKind}/${e.involvedName}/${e.reason}/${e.lastTimestamp ?? ''}/${e.message}`} variant="body2">
              <Typography component="span" variant="body2" sx={{ color: statusTextColor('warning'), fontWeight: 600 }}>
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
              —{' '}
              {gvr ? (
                <Link
                  component={RouterLink}
                  to={kindListPath(gvr, { sel: { ctx, namespace, name: e.involvedName } })}
                  underline="hover"
                  sx={{ fontWeight: 500 }}
                >
                  {label}
                </Link>
              ) : (
                label
              )}
              : {e.message}
            </Typography>
          );
        })}
      </Stack>
    </ProblemCard>
  );
}

/**
 * An overview section: outlined card with a heading row (title, optional
 * count and one-line summary, right-aligned controls) and a body. `flush`
 * runs tables edge to edge. Not collapsible, so its title stays a real
 * heading for screen readers and tests.
 */
export function ProblemCard({
  title,
  count,
  description,
  action,
  flush = false,
  anchor,
  children,
}: {
  title: string;
  count?: number;
  description?: React.ReactNode;
  action?: React.ReactNode;
  flush?: boolean;
  /** In-page jump target for the attention tiles (`data-anchor`). */
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <Box data-anchor={anchor} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper', scrollMarginTop: 8 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75, rowGap: 0.5, minHeight: 42, px: 1.5, py: 0.75 }}>
        <Typography variant="subtitle2" component="h3" sx={{ flexShrink: 0 }}>
          {title}
        </Typography>
        {count !== undefined && <CountPill value={count} />}
        {description && (
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0, ml: 0.25 }}>
            {description}
          </Typography>
        )}
        {action && <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>{action}</Box>}
      </Box>
      <Box
        sx={{
          borderTop: 1,
          borderColor: 'divider',
          p: flush ? 0 : 1.5,
          ...(flush && { overflowX: 'auto', '& .MuiTableRow-root:last-child .MuiTableCell-body': { borderBottom: 0 } }),
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
