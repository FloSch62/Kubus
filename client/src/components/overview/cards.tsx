import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { useNavigate } from 'react-router';
import { groupToPath, type OverviewProblemPod, type OverviewWarningEvent } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';

/** List-page path for a kind, optionally deep-linking a selection via ?sel=. */
export function kindListPath(
  gvr: { group: string; version: string; plural: string },
  opts?: { sel?: { ctx: string; namespace?: string; name: string } },
): string {
  const params = new URLSearchParams();
  if (opts?.sel) params.set('sel', `${opts.sel.ctx}|${opts.sel.namespace ?? ''}|${opts.sel.name}`);
  const q = params.toString();
  return `/r/${groupToPath(gvr.group)}/${gvr.version}/${gvr.plural}${q ? `?${q}` : ''}`;
}

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
              <TableCell sx={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.message}>
                {p.message ?? ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ProblemCard>
  );
}

export function WarningEventsCard({ events }: { events: OverviewWarningEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ProblemCard title="Warning events (1h)">
      <Stack spacing={0.5}>
        {events.slice(0, 15).map((e) => (
          <Typography key={`${e.namespace}/${e.involvedKind}/${e.involvedName}/${e.reason}/${e.lastTimestamp ?? ''}/${e.message}`} variant="body2">
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
