import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import CircleIcon from '@mui/icons-material/Circle';
import type { ContextHealth, ContextInfo } from '@kubus/shared';

export const HEALTH_COLOR: Record<ContextHealth, 'success' | 'error' | 'warning' | 'disabled'> = {
  connected: 'success',
  error: 'error',
  connecting: 'warning',
  unknown: 'disabled',
};

export function healthTitle(c: ContextInfo): string {
  if (c.health === 'connected') return c.kubernetesVersion ? `Connected · ${c.kubernetesVersion}` : 'Connected';
  if (c.health === 'connecting') return 'Checking connectivity';
  if (c.health === 'error') return c.healthMessage ?? 'Connection failed';
  return 'Not checked yet';
}

/** Colored connection-state dot for a context; a spinner while connecting. */
export function ContextHealthDot({ info, size = 12 }: { info: ContextInfo | undefined; size?: number }) {
  if (!info) return null;
  return (
    <Tooltip title={healthTitle(info)}>
      {info.health === 'connecting' ? (
        <CircularProgress size={size} sx={{ color: 'warning.main' }} />
      ) : (
        <CircleIcon color={HEALTH_COLOR[info.health]} sx={{ fontSize: size }} />
      )}
    </Tooltip>
  );
}
