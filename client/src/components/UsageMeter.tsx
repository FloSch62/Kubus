import { CellTooltip as Tooltip } from './CellTooltip.js';

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
      <span className="kubus-usage-value">{text}</span>
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
      <span className="kubus-usage">
        <span className="kubus-usage-value">{text}</span>
        <span className={`kubus-usage-track${pct === undefined ? ' kubus-usage-empty' : ''}`}>
          {pct !== undefined && <progress
            className={`kubus-usage-fill kubus-usage-${usageColor(pct)}`}
            aria-label={tip} max={100} value={Math.max(0, Math.min(100, pct))}
          />}
          {markerPct !== undefined && <span className="kubus-usage-marker" style={{ left: `${markerPct}%` }} />}
        </span>
      </span>
    </Tooltip>
  );
}
