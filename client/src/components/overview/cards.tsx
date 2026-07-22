import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { Link as RouterLink, useNavigate } from 'react-router';
import { gvkForKind, type OverviewProblemPod, type OverviewWarningEvent } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { useApiResources } from '../../api/queries.js';
import { kindListPath } from '../../resource-links.js';
import { statusTextColor } from '../../theme.js';

export { kindListPath };

export function FailingPodsCard({ ctx, pods, hideNamespace }: { ctx: string; pods: OverviewProblemPod[]; hideNamespace?: boolean }) {
  const navigate = useNavigate();
  if (pods.length === 0) return null;
  return (
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
              <TableCell title={p.message}>
                <Box sx={{ maxWidth: 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.message ?? ''}</Box>
              </TableCell>
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
    <ProblemCard title="Warning events (1h)">
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

export function StatCard({
  label,
  value,
  sub,
  warn,
  icon,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  warn?: boolean;
  icon?: React.ReactElement;
  onClick?: () => void;
}) {
  // Six-up only on wide screens; mid widths get four-up so the values never
  // ellipsize before the labels do.
  return (
    <Grid size={{ xs: 6, sm: 4, md: 3, lg: 2 }}>
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
                  borderRadius: 1.5,
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

export function ProblemCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, gap: 1 }}>
          <Typography variant="subtitle2">{title}</Typography>
          {action}
        </Box>
        {children}
      </CardContent>
    </Card>
  );
}
