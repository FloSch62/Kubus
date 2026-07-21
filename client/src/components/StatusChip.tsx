import Box from '@mui/material/Box';
import CircleIcon from '@mui/icons-material/Circle';
import { statusTextColor } from '../theme.js';

const GOOD = new Set(['running', 'succeeded', 'active', 'bound', 'ready', 'available', 'complete', 'completed', 'deployed', 'true', 'healthy', 'synced', 'up', 'attached']);
const BAD = new Set(['failed', 'crashloopbackoff', 'imagepullbackoff', 'errimagepull', 'error', 'evicted', 'lost', 'notready', 'oomkilled', 'false', 'unhealthy', 'degraded', 'stopped', 'down', 'notestablished', 'nameconflict']);
const WARN = new Set([
  'pending',
  'terminating',
  'containercreating',
  'podinitializing',
  'released',
  'unknown',
  'warning',
  'schedulingdisabled',
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'superseded',
  'uninstalling',
]);

export function statusColor(status: string): 'success' | 'error' | 'warning' | 'default' {
  const normalized = status.trim().toLowerCase();
  if (GOOD.has(normalized)) return 'success';
  if (BAD.has(normalized)) return 'error';
  if (WARN.has(normalized)) return 'warning';
  return 'default';
}

export function StatusChip({ status, label }: { status: string; label?: string }) {
  if (!status) return null;
  const color = statusColor(status);
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        fontSize: 12.5,
        fontWeight: 550,
        lineHeight: 1.6,
        color: color === 'default' ? 'text.secondary' : statusTextColor(color),
      }}
    >
      <CircleIcon sx={{ fontSize: 7, opacity: color === 'default' ? 0.6 : 1 }} />
      {label ?? status}
    </Box>
  );
}
