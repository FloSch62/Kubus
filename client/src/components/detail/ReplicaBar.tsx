import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { statusTextColor } from '../../theme.js';

/**
 * Rollout progress at a glance: a track of `desired` slots filled by ready
 * replicas (green), replicas that exist but aren't ready yet (amber), and
 * surge replicas beyond desired hanging off the end. The caption spells
 * out the same numbers.
 */
export function ReplicaBar({ desired, ready, total, updated, paused }: { desired: number; ready: number; total: number; updated: number; paused?: boolean }) {
  const span = Math.max(desired, total, 1);
  const readyPct = (Math.min(ready, span) / span) * 100;
  const pendingPct = (Math.max(0, Math.min(total, span) - ready) / span) * 100;
  const stale = Math.max(0, total - updated);
  const parts = [
    `${ready} of ${desired} ready`,
    total > desired ? `${total - desired} surge` : undefined,
    stale > 0 ? `${stale} on old template` : undefined,
    paused ? 'rollout paused' : undefined,
  ].filter(Boolean);
  const tone = desired === 0 ? undefined : ready >= desired ? 'success' : ready === 0 ? 'error' : 'warning';
  return (
    <Tooltip title={`${ready} ready · ${total} existing · ${updated} on current template · ${desired} desired`}>
      <Box sx={{ px: 0.25 }}>
        <Box sx={{ position: 'relative', height: 6, borderRadius: 999, bgcolor: 'action.hover', overflow: 'hidden' }}>
          <Box sx={{ position: 'absolute', inset: 0, width: `${readyPct}%`, bgcolor: 'success.main', transition: 'width 300ms ease' }} />
          <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${readyPct}%`, width: `${pendingPct}%`, bgcolor: 'warning.main', opacity: 0.85, transition: 'left 300ms ease, width 300ms ease' }} />
          {desired > 0 && desired < span && (
            <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${(desired / span) * 100}%`, width: 2, bgcolor: 'text.primary' }} />
          )}
        </Box>
        <Stack direction="row" sx={{ justifyContent: 'space-between', mt: 0.5, gap: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 550, color: tone ? statusTextColor(tone) : 'text.secondary' }}>
            {parts[0]}
          </Typography>
          {parts.length > 1 && (
            <Typography variant="caption" color="text.secondary" noWrap>
              {parts.slice(1).join(' · ')}
            </Typography>
          )}
        </Stack>
      </Box>
    </Tooltip>
  );
}
