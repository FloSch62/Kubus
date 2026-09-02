import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { PodEnvVar } from '@kubus/shared';
import { CopyValueButton } from '../CellCopy.js';
import { statusTextColor } from '../../theme.js';

export type EnvRefKind = 'ConfigMap' | 'Secret';

function envSourceLabel(env: PodEnvVar): { text: string; refKind?: EnvRefKind; refName?: string } {
  const s = env.source;
  if (!s || s.type === 'literal') return { text: '' };
  if (s.type === 'fieldRef') return { text: `field ${s.key ?? ''}` };
  if (s.type === 'resourceFieldRef') return { text: `resource ${s.key ?? ''}` };
  const isSecret = s.type === 'secretKeyRef' || s.type === 'secretRef';
  const base = `${isSecret ? 'secret' : 'configmap'}/${s.ref ?? ''}`;
  // The key only earns space when it differs from the variable name.
  const showKey = s.key && s.key !== env.name && s.type !== 'configMapRef' && s.type !== 'secretRef';
  return { text: showKey ? `${base} → ${s.key}` : base, refKind: isSecret ? 'Secret' : 'ConfigMap', refName: s.ref };
}

/**
 * One container's environment: name, value and where it comes from. Rows
 * whose name a later entry overrides (Kubernetes resolves last-wins) are
 * struck through. Secret-backed values stay masked until revealed.
 */
export function EnvTable({
  env,
  loading,
  reveal = false,
  onReveal,
  onOpenRef,
}: {
  env: PodEnvVar[] | undefined;
  loading?: boolean;
  reveal?: boolean;
  /** Present when secret values can be revealed (live pods). */
  onReveal?: (reveal: boolean) => void;
  onOpenRef?: (kind: EnvRefKind, name: string) => void;
}) {
  if (loading && !env) {
    return (
      <Box sx={{ p: 1 }}>
        <CircularProgress size={16} />
      </Box>
    );
  }
  const rows = env ?? [];
  if (!rows.length) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1 }}>
        No environment variables.
      </Typography>
    );
  }
  const hasSecrets = rows.some((e) => e.redacted);
  const lastIndexByName = new Map<string, number>();
  rows.forEach((e, i) => lastIndexByName.set(e.name, i));
  return (
    <Box>
      {hasSecrets && onReveal && (
        <Stack direction="row" sx={{ justifyContent: 'flex-end', px: 1, pt: 0.25 }}>
          <FormControlLabel
            sx={{ mr: 0 }}
            control={<Switch size="small" checked={reveal} onChange={(e) => onReveal(e.target.checked)} />}
            label={<Typography variant="caption">Reveal secret values</Typography>}
          />
        </Stack>
      )}
      <Table size="small" sx={{ '& td': { px: 1, py: 0.5 }, '& tr:last-child td': { borderBottom: 0 } }}>
        <TableBody>
          {rows.map((e, i) => {
            const source = envSourceLabel(e);
            const overridden = lastIndexByName.get(e.name) !== i;
            const hidden = !!e.redacted && !reveal;
            const copyable = !e.error && !hidden && !!e.value;
            // Declared-only references (workload templates) have no value to show.
            const unresolved = e.value === undefined && !e.error && !hidden;
            return (
              <TableRow
                key={`${e.name}:${i}`}
                sx={{ '& .kubus-env-copy': { opacity: 0, transition: 'opacity 120ms' }, '&:hover .kubus-env-copy': { opacity: 1 } }}
              >
                <TableCell
                  sx={{
                    width: '1%',
                    verticalAlign: 'top',
                    fontFamily: 'monospace',
                    fontSize: 12,
                    ...(overridden && { color: 'text.disabled', textDecoration: 'line-through' }),
                  }}
                >
                  <Box sx={{ maxWidth: 220, wordBreak: 'break-all' }}>
                    {overridden ? (
                      <Tooltip title="Shadowed — a later entry with the same name wins.">
                        <span>{e.name}</span>
                      </Tooltip>
                    ) : (
                      e.name
                    )}
                  </Box>
                </TableCell>
                <TableCell
                  sx={{
                    verticalAlign: 'top',
                    fontFamily: 'monospace',
                    fontSize: 12,
                    wordBreak: 'break-word',
                    position: 'relative',
                    ...(overridden && { color: 'text.disabled' }),
                    ...(hidden && { color: 'text.secondary', letterSpacing: 1 }),
                  }}
                >
                  {e.error ? (
                    <Typography component="span" variant="caption" sx={{ color: statusTextColor('warning') }}>
                      {e.error}
                    </Typography>
                  ) : unresolved ? (
                    <Typography component="span" variant="caption" color="text.disabled">
                      resolved at run time
                    </Typography>
                  ) : (
                    (e.value ?? '')
                  )}
                  {copyable && (
                    <Box
                      className="kubus-env-copy"
                      sx={{ position: 'absolute', top: 2, right: 0, bgcolor: 'background.paper', borderRadius: 1, boxShadow: 1 }}
                    >
                      <CopyValueButton text={e.value!} label={`Copy value of ${e.name}`} />
                    </Box>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ verticalAlign: 'top', width: '1%' }}>
                  <Box sx={{ maxWidth: 220, wordBreak: 'break-word', ml: 'auto' }}>
                    {source.refKind && source.refName && onOpenRef ? (
                      <Link component="button" variant="caption" color="text.secondary" onClick={() => onOpenRef(source.refKind!, source.refName!)}>
                        {source.text}
                      </Link>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {source.text}
                      </Typography>
                    )}
                  </Box>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}
