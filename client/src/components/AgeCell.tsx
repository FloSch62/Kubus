import { useSyncExternalStore } from 'react';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { TypographyProps } from '@mui/material/Typography';

const tickListeners = new Set<() => void>();
let tickTimer: number | undefined;
let tickCount = 0;

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickListeners.size === 1) {
    tickTimer = window.setInterval(() => {
      tickCount += 1;
      for (const l of tickListeners) l();
    }, 10_000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0) window.clearInterval(tickTimer);
  };
}

function getTick(): number {
  return tickCount;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
  const y = Math.floor(d / 365);
  return y >= 1 ? `${y}y${Math.floor((d % 365) / 30)}mo` : `${Math.floor(d / 30)}mo`;
}

export function formatAge(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const ms = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(ms)) return '0s';
  // Future timestamps (expiry dates in CRD columns) used to clamp to "0s".
  if (ms < -30_000) return `in ${formatDuration(-ms)}`;
  return formatDuration(Math.max(0, ms));
}

/** Direction-aware relative time: "5d ago" for the past, "in 47d" for the future. */
export function formatRelative(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const diff = Date.parse(timestamp) - Date.now();
  if (Number.isNaN(diff)) return '';
  if (Math.abs(diff) < 30_000) return 'now';
  return diff > 0 ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}

/** Live-ticking relative age. */
export function AgeCell({ timestamp, variant = 'body2' }: { timestamp?: string; variant?: TypographyProps['variant'] }) {
  useSyncExternalStore(subscribeTick, getTick);
  if (!timestamp) return null;
  return (
    <Tooltip title={new Date(timestamp).toLocaleString()}>
      <Typography variant={variant} component="span">
        {formatAge(timestamp)}
      </Typography>
    </Tooltip>
  );
}

/**
 * Live-ticking relative time that handles future timestamps (certificate
 * expiry, renewal times) — includes the "ago"/"in" direction itself.
 */
export function RelativeTimeCell({ timestamp, variant = 'body2' }: { timestamp?: string; variant?: TypographyProps['variant'] }) {
  useSyncExternalStore(subscribeTick, getTick);
  if (!timestamp) return null;
  return (
    <Tooltip title={new Date(timestamp).toLocaleString()}>
      <Typography variant={variant} component="span">
        {formatRelative(timestamp)}
      </Typography>
    </Tooltip>
  );
}
