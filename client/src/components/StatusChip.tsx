import Box from '@mui/material/Box';
import CircleIcon from '@mui/icons-material/Circle';

const GOOD = new Set(['Running', 'Succeeded', 'Active', 'Bound', 'Ready', 'Available', 'Completed', 'deployed', 'True']);
const BAD = new Set(['Failed', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'Error', 'Evicted', 'Lost', 'NotReady', 'failed', 'OOMKilled']);
const WARN = new Set(['Pending', 'Terminating', 'ContainerCreating', 'PodInitializing', 'Released', 'Unknown', 'SchedulingDisabled', 'pending-install', 'pending-upgrade', 'superseded', 'uninstalling']);

export function statusColor(status: string): 'success' | 'error' | 'warning' | 'default' {
  if (GOOD.has(status)) return 'success';
  if (BAD.has(status)) return 'error';
  if (WARN.has(status)) return 'warning';
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
        color: color === 'default' ? 'text.secondary' : `${color}.main`,
      }}
    >
      <CircleIcon sx={{ fontSize: 7, opacity: color === 'default' ? 0.6 : 1 }} />
      {label ?? status}
    </Box>
  );
}
