import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

export function usageColor(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 100 ? 'error' : pct >= 80 ? 'warning' : 'success';
}

/**
 * Compact usage readout: absolute value in a fixed-width slot plus a
 * utilization bar when a reference total (requests or limits) is known.
 * Shared by the list CPU/Memory cells, PodMiniList and the detail
 * container cards.
 *
 * Under budget the track spans the reference total. Over budget it rescales
 * to actual usage and a tick marks where the request/limit sits, so 154% and
 * 400% look as different as they are.
 */
export function UsageMeter({
  value,
  max,
  format,
  maxHint = 'requested',
  emptyHint,
  placeholder = false,
}: {
  value: number;
  /** Reference total the bar fills against; omitted → no fill. */
  max?: number;
  format: (v: number) => string;
  /** What `max` represents, for the tooltip (e.g. "requested", "limit"). */
  maxHint?: string;
  /** Tooltip when there is no `max`, e.g. "no CPU requests set". */
  emptyHint?: string;
  /**
   * Without `max`: render an empty bar track so columns keep a uniform
   * layout (list cells); off for container cards, whose req/lim caption
   * already explains the missing bar.
   */
  placeholder?: boolean;
}) {
  const text = format(value);
  if (!max && !placeholder) {
    return (
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {text}
      </Typography>
    );
  }
  const pct = max ? (value / max) * 100 : undefined;
  const over = pct !== undefined && pct > 100;
  // Position of the request/limit tick on a track rescaled to `value`.
  const markerPct = over ? (max! / value) * 100 : undefined;
  const tip =
    pct !== undefined
      ? `${text} of ${format(max!)} ${maxHint} (${pct.toFixed(0)}%)${over ? ` — ${format(value - max!)} over` : ''}`
      : `${text} · ${emptyHint ?? 'no requests set'}`;
  return (
    <Tooltip title={tip}>
      <Box sx={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ fontWeight: 600, flexShrink: 0, minWidth: 44 }}>
          {text}
        </Typography>
        {pct !== undefined ? (
          <Box sx={{ position: 'relative', flex: 1, minWidth: 36 }}>
            <LinearProgress
              variant="determinate"
              value={over ? 100 : Math.max(0, Math.min(100, pct))}
              color={usageColor(pct)}
              sx={{ height: 5, borderRadius: 999, bgcolor: 'action.hover' }}
            />
            {markerPct !== undefined && (
              <Box
                sx={(theme) => ({
                  position: 'absolute',
                  top: '50%',
                  left: `${markerPct}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 2,
                  height: 11,
                  borderRadius: 1,
                  bgcolor: 'text.primary',
                  boxShadow: `0 0 0 1px ${theme.palette.background.paper}`,
                })}
              />
            )}
          </Box>
        ) : (
          <Box sx={{ flex: 1, minWidth: 36, height: 5, borderRadius: 999, bgcolor: 'action.hover', opacity: 0.5 }} />
        )}
      </Box>
    </Tooltip>
  );
}
