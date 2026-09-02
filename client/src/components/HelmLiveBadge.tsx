import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { keyframes } from '@mui/material/styles';
import type { HelmWatchStatus } from '@kubus/shared';
import { helmWatchLive, useHelmWatchStatus } from '../api/queries.js';
import { statusTextColor } from '../theme.js';
import { AgeCell } from './AgeCell.js';

const pulse = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.3; }
  100% { opacity: 1; }
`;

function describe(ctx: string, status: HelmWatchStatus | undefined): string {
  if (!status) return `${ctx}: connecting`;
  switch (status.state) {
    case 'live':
      return `${ctx}: live${status.message ? ` (${status.message})` : ''}`;
    case 'unavailable':
      return `${ctx}: polling, ${status.message ?? 'release records cannot be watched'}`;
    case 'error':
      return `${ctx}: polling, ${status.message ?? 'the record watch failed'}`;
    default:
      return `${ctx}: reconnecting${status.message ? `, ${status.message}` : ''}`;
  }
}

/**
 * Whether release changes stream in for these clusters or arrive on the
 * safety-net poll. Sits in page headers next to the counts; the tooltip
 * names every cluster and explains any that is polling.
 */
export function HelmLiveBadge({ contexts, updatedAt }: { contexts: string[]; updatedAt?: number }) {
  const { data } = useHelmWatchStatus();
  const live = helmWatchLive(data, contexts);
  const liveCount = contexts.filter((ctx) => data?.[ctx]?.state === 'live').length;
  const connecting = !live && contexts.some((ctx) => !data?.[ctx] || data[ctx]?.state === 'reconnecting');
  const label = live ? 'Live' : liveCount ? `Live ${liveCount}/${contexts.length}` : connecting ? 'Connecting' : 'Polling';
  const color = live ? statusTextColor('success') : liveCount || connecting ? statusTextColor('warning') : 'text.secondary';
  const title = (
    <Box>
      {contexts.map((ctx) => (
        <Typography key={ctx} variant="caption" sx={{ display: 'block' }}>
          {describe(ctx, data?.[ctx])}
        </Typography>
      ))}
      {updatedAt ? (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
          Refreshed <AgeCell timestamp={new Date(updatedAt).toISOString()} variant="caption" /> ago
        </Typography>
      ) : null}
    </Box>
  );
  return (
    <Tooltip title={title}>
      <Box
        component="span"
        aria-label={`Helm updates: ${label}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          height: 24,
          borderRadius: 999,
          border: '1px solid',
          borderColor: 'divider',
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          color,
          cursor: 'default',
        }}
      >
        <Box
          component="span"
          sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'currentColor', flexShrink: 0, animation: live ? `${pulse} 2.4s ease-in-out infinite` : 'none' }}
        />
        {label}
      </Box>
    </Tooltip>
  );
}
