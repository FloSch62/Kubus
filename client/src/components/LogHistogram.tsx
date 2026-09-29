import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import type { LogLevel } from './log-format.js';
import {
  buildHistogram,
  formatBucketWidth,
  HISTOGRAM_LEVELS,
  type HistogramBucket,
  type HistogramLevel,
  type LogEntry,
  type LogLine,
  type LogMarkerTone,
} from './log-tools.js';

const BAR_HEIGHT = 24;
/** Target bar pitch in px; the bucket width rounds to 0.1 s, 1 s, 5 s, 1 min, … */
const BAR_PITCH = 7;
const MAX_BAR_WIDTH = 10;

const LEVEL_NAMES: Record<HistogramLevel, string> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'trace',
  none: 'no level',
};

export interface LogHistogramProps {
  entries: readonly LogEntry[];
  levelOf: (line: LogLine) => LogLevel | undefined;
  colors: Record<HistogramLevel, string>;
  markerColors: Record<LogMarkerTone, string>;
  formatTime: (ms: number) => string;
  /** Jump to the first entry of a bucket (its index in `entries`). */
  onJump: (index: number) => void;
}

function bucketSummary(bucket: HistogramBucket, bucketMs: number, formatTime: (ms: number) => string): string {
  const range = `${formatTime(bucket.start)} to ${formatTime(bucket.start + bucketMs)}`;
  if (!bucket.total && !bucket.markers.length) return `${range} · no lines`;
  const levels = HISTOGRAM_LEVELS.filter((level) => bucket.counts[level] > 0)
    .map((level) => `${bucket.counts[level]} ${LEVEL_NAMES[level]}`)
    .join(', ');
  const marks = bucket.markers.map((marker) => marker.label).join(' · ');
  return [`${range} · ${bucket.total} ${bucket.total === 1 ? 'line' : 'lines'}${levels ? ` (${levels})` : ''}`, marks].filter(Boolean).join('\n');
}

/**
 * Log volume over time, stacked by level. Clicking a bar (or Enter on the
 * focused strip) jumps the view to the first line in that time slice.
 */
export const LogHistogram = memo(function LogHistogram({ entries, levelOf, colors, markerColors, formatTime, onJump }: LogHistogramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | undefined>();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const histogram = useMemo(
    () => (width > 0 ? buildHistogram(entries, Math.max(12, Math.floor(width / BAR_PITCH)), levelOf) : undefined),
    [entries, levelOf, width],
  );
  const buckets = histogram?.buckets ?? [];
  const pitch = buckets.length ? width / buckets.length : 0;
  const hovered = hover !== undefined ? buckets[hover] : undefined;

  const bucketAt = (clientX: number): number | undefined => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !buckets.length) return undefined;
    return Math.min(buckets.length - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * buckets.length)));
  };
  const jump = (index: number | undefined) => {
    const bucket = index !== undefined ? buckets[index] : undefined;
    if (bucket && bucket.first >= 0) onJump(bucket.first);
  };

  const label = histogram
    ? `Log volume, ${formatBucketWidth(histogram.bucketMs)} per bar, ${formatTime(histogram.start)} to ${formatTime(histogram.end)}. Click a bar to jump to that moment.`
    : 'Log volume over time';

  return (
    <Box sx={{ flex: '1 1 240px', minWidth: 160, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Tooltip
        title={hovered && histogram ? <Box sx={{ whiteSpace: 'pre-line' }}>{bucketSummary(hovered, histogram.bucketMs, formatTime)}</Box> : ''}
        followCursor
        placement="top"
        disableInteractive
      >
        <Box
          ref={ref}
          tabIndex={0}
          aria-label={label}
          onMouseMove={(event) => setHover(bucketAt(event.clientX))}
          onMouseLeave={() => setHover(undefined)}
          onClick={(event) => jump(bucketAt(event.clientX))}
          onKeyDown={(event) => {
            if (!buckets.length) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const step = event.key === 'ArrowLeft' ? -1 : 1;
              setHover((current) => Math.min(buckets.length - 1, Math.max(0, (current ?? (step < 0 ? buckets.length : -1)) + step)));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              jump(hover);
            }
          }}
          onBlur={() => setHover(undefined)}
          sx={{
            position: 'relative',
            height: BAR_HEIGHT,
            cursor: buckets.length ? 'pointer' : 'default',
            borderBottom: 1,
            borderColor: 'divider',
            borderRadius: 0.5,
            outline: 'none',
            '&:focus-visible': { boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}` },
          }}
        >
          {width > 0 && histogram ? (
            <svg width={width} height={BAR_HEIGHT} style={{ display: 'block' }} aria-hidden="true">
              {hover !== undefined ? <rect x={hover * pitch} y={0} width={pitch} height={BAR_HEIGHT} fill="currentColor" opacity={0.08} /> : null}
              {buckets.map((bucket, index) => {
                if (!bucket.total) return null;
                // Few buckets (a short burst of lines) draw as slim bars, not slabs.
                const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(1, pitch - 1.5));
                const x = index * pitch + (pitch - barWidth) / 2;
                let y = BAR_HEIGHT;
                return HISTOGRAM_LEVELS.map((level) => {
                  const count = bucket.counts[level];
                  if (!count) return null;
                  const height = Math.max(1.5, (count / histogram.max) * (BAR_HEIGHT - 2));
                  y = Math.max(0, y - height);
                  return <rect key={`${index}-${level}`} x={x} y={y} width={barWidth} height={height} fill={colors[level]} />;
                });
              })}
              {buckets.map((bucket, index) => {
                const marker = bucket.markers.at(-1);
                if (!marker) return null;
                const x = index * pitch + pitch / 2;
                return <line key={`m-${index}`} x1={x} x2={x} y1={0} y2={BAR_HEIGHT} stroke={markerColors[marker.tone]} strokeWidth={1} strokeDasharray="2 2" />;
              })}
            </svg>
          ) : null}
        </Box>
      </Tooltip>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, fontSize: 10, lineHeight: 1.2, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
        {histogram ? (
          <>
            <span>{formatTime(histogram.start)}</span>
            <span>{formatBucketWidth(histogram.bucketMs)} per bar</span>
            <span>{formatTime(histogram.end)}</span>
          </>
        ) : (
          <span>No lines yet</span>
        )}
      </Box>
    </Box>
  );
});
