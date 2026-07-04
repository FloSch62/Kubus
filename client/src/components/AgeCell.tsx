import { useEffect, useState } from 'react';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

export function formatAge(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const ms = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(ms) || ms < 0) return '0s';
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

/** Live-ticking relative age. */
export function AgeCell({ timestamp }: { timestamp?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 10_000);
    return () => window.clearInterval(t);
  }, []);
  if (!timestamp) return null;
  return (
    <Tooltip title={new Date(timestamp).toLocaleString()}>
      <Typography variant="body2" component="span">
        {formatAge(timestamp)}
      </Typography>
    </Tooltip>
  );
}
