/**
 * Pure helpers behind the log viewer: buffer entry types, export formats,
 * the volume histogram, variable-height row offsets and text matching.
 */
import { stripAnsi, type LogLevel } from './log-format.js';

export interface LogLine {
  kind: 'line';
  pod: string;
  container: string;
  ts?: string;
  line: string;
  receivedAt: number;
  /** Epoch ms of `ts`, or of arrival when the line has none. */
  at: number;
}

export type LogMarkerTone = 'manual' | 'warning' | 'success' | 'joined' | 'left';

export interface LogMarker {
  kind: 'marker';
  label: string;
  tone: LogMarkerTone;
  receivedAt: number;
}

export type LogEntry = LogLine | LogMarker;

export function logLine(pod: string, container: string, line: string, ts?: string, now = Date.now()): LogLine {
  const parsed = ts ? Date.parse(ts) : Number.NaN;
  return { kind: 'line', pod, container, ts, line, receivedAt: now, at: Number.isFinite(parsed) ? parsed : now };
}

/**
 * Append `fresh` to `existing` (a new array) keeping lines in time order:
 * pods stream their backlogs one after another and their live lines arrive
 * slightly interleaved, so each batch is sorted and merged into the tail.
 * Markers stay where they arrived and act as barriers lines never cross.
 * Sorting is stable, so lines of one source keep their order.
 */
export function mergeByTime(existing: readonly LogEntry[], fresh: readonly LogEntry[]): LogEntry[] {
  const result = existing.slice();
  let barrier = -1;
  for (let index = result.length - 1; index >= 0; index--) {
    if (result[index]!.kind === 'marker') {
      barrier = index;
      break;
    }
  }
  let start = 0;
  const mergeRun = (end: number) => {
    if (end <= start) return;
    const run = (fresh.slice(start, end) as LogLine[]).sort((a, b) => a.at - b.at);
    // First index after the barrier whose line is newer than the run's oldest.
    let insertAt = result.length;
    while (insertAt - 1 > barrier && (result[insertAt - 1] as LogLine).at > run[0]!.at) insertAt--;
    if (insertAt === result.length) {
      for (const line of run) result.push(line);
      return;
    }
    const tail = result.splice(insertAt) as LogLine[];
    let a = 0;
    let b = 0;
    while (a < tail.length && b < run.length) result.push(tail[a]!.at <= run[b]!.at ? tail[a++]! : run[b++]!);
    while (a < tail.length) result.push(tail[a++]!);
    while (b < run.length) result.push(run[b++]!);
  };
  fresh.forEach((entry, index) => {
    if (entry.kind !== 'marker') return;
    mergeRun(index);
    result.push(entry);
    barrier = result.length - 1;
    start = index + 1;
  });
  mergeRun(fresh.length);
  return result;
}

// ---- Text matching ----

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** A regex test for `pattern`, or a plain substring test when it is not a valid regex. */
export function textMatcher(pattern: string, matchCase: boolean): ((text: string) => boolean) | undefined {
  if (!pattern) return undefined;
  if (isValidRegex(pattern)) {
    const re = new RegExp(pattern, matchCase ? '' : 'i');
    return (text) => re.test(text);
  }
  if (matchCase) return (text) => text.includes(pattern);
  const needle = pattern.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

// ---- Export ----

export type LogExportFormat = 'shown' | 'raw' | 'timestamps' | 'ndjson';

export const LOG_EXPORT_FORMATS: ReadonlyArray<{ value: LogExportFormat; label: string; hint: string; ext: string; mime: string }> = [
  { value: 'shown', label: 'As shown', hint: 'Lines as the view shows them, with full pod and container, time and markers', ext: 'log', mime: 'text/plain' },
  { value: 'raw', label: 'Raw', hint: 'Only the lines, exactly as the containers wrote them', ext: 'log', mime: 'text/plain' },
  { value: 'timestamps', label: 'With timestamps', hint: 'RFC 3339 timestamp and source before each line', ext: 'log', mime: 'text/plain' },
  { value: 'ndjson', label: 'NDJSON', hint: 'One JSON object per line, for jq and log tools', ext: 'ndjson', mime: 'application/x-ndjson' },
];

export interface LogExportOptions {
  /** The viewer shows a source column (several pods or containers). */
  showSource: boolean;
  /** The source column names the pod as well as the container. */
  showPod: boolean;
  /** Timestamp as displayed, or undefined when timestamps are hidden. */
  formatTs?: (ts: string) => string;
  /** A line's text as displayed (the message view), when it differs from the raw line. */
  displayText?: (line: LogLine) => string;
  levelOf: (line: LogLine) => LogLevel | undefined;
}

/**
 * Short labels for the pods of one log tab. A workload's pods share their
 * name up to a random suffix, so the shortest unique tail (whole dash
 * segments, at least 3 characters) is enough to tell them apart on screen.
 * Short names stay whole.
 */
export function shortPodLabels(pods: readonly string[]): Map<string, string> {
  const unique = [...new Set(pods)];
  const labels = new Map<string, string>();
  for (const pod of unique) {
    let label = pod;
    if (pod.length > 16) {
      const parts = pod.split('-');
      for (let take = 1; take < parts.length; take += 1) {
        const tail = parts.slice(-take).join('-');
        if (tail.length < 3) continue;
        if (!unique.some((other) => other !== pod && (other === tail || other.endsWith(`-${tail}`)))) {
          label = tail;
          break;
        }
      }
    }
    labels.set(pod, label);
  }
  return labels;
}

function sourceOf(line: LogLine, showPod: boolean): string {
  return showPod ? [line.pod, line.container].filter(Boolean).join('/') : line.container;
}

export function formatLogExport(entries: readonly LogEntry[], format: LogExportFormat, options: LogExportOptions): string {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'marker') {
      if (format === 'shown') out.push(`--- ${entry.label} ---`);
      continue;
    }
    switch (format) {
      case 'raw':
        out.push(entry.line);
        break;
      case 'timestamps': {
        const ts = entry.ts ?? new Date(entry.at).toISOString();
        out.push(`${ts} ${options.showSource ? `[${entry.pod}/${entry.container}] ` : ''}${stripAnsi(entry.line)}`);
        break;
      }
      case 'ndjson': {
        const level = options.levelOf(entry);
        out.push(
          JSON.stringify({
            ts: entry.ts ?? new Date(entry.at).toISOString(),
            pod: entry.pod,
            container: entry.container,
            ...(level ? { level } : {}),
            message: stripAnsi(entry.line),
          }),
        );
        break;
      }
      default: {
        const parts: string[] = [];
        if (options.showSource) parts.push(sourceOf(entry, options.showPod));
        if (options.formatTs && entry.ts) parts.push(options.formatTs(entry.ts));
        parts.push(options.displayText?.(entry) ?? stripAnsi(entry.line));
        out.push(parts.join(' '));
      }
    }
  }
  return out.join('\n');
}

// ---- Volume histogram ----

export type HistogramLevel = LogLevel | 'none';

/** Stack order, bottom up: errors sit on the baseline where they are easiest to spot. */
export const HISTOGRAM_LEVELS: readonly HistogramLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'none'];

export interface HistogramBucket {
  start: number;
  counts: Record<HistogramLevel, number>;
  total: number;
  /** Index of the first entry (in buffer order) that falls in this bucket. */
  first: number;
  /** Membership changes and manual markers that landed in this bucket. */
  markers: LogMarker[];
}

export interface LogHistogram {
  start: number;
  end: number;
  bucketMs: number;
  buckets: HistogramBucket[];
  max: number;
}

const BUCKET_STEPS_MS = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
  10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

function emptyCounts(): Record<HistogramLevel, number> {
  return { error: 0, warn: 0, info: 0, debug: 0, trace: 0, none: 0 };
}

/**
 * Bucket lines by time into at most `maxBuckets` bars of a round width
 * (0.1 s, 1 s, 5 s, 1 min, …), counting each level separately.
 */
export function buildHistogram(
  entries: readonly LogEntry[],
  maxBuckets: number,
  levelOf: (line: LogLine) => LogLevel | undefined,
): LogHistogram | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const entry of entries) {
    if (entry.kind !== 'line') continue;
    if (entry.at < min) min = entry.at;
    if (entry.at > max) max = entry.at;
  }
  if (min === Infinity) return undefined;
  const span = Math.max(1, max - min + 1);
  const target = span / Math.max(1, maxBuckets);
  const bucketMs = BUCKET_STEPS_MS.find((step) => step >= target) ?? Math.ceil(target / 86_400_000) * 86_400_000;
  const start = Math.floor(min / bucketMs) * bucketMs;
  const count = Math.floor((max - start) / bucketMs) + 1;
  const buckets: HistogramBucket[] = Array.from({ length: count }, (_, index) => ({
    start: start + index * bucketMs,
    counts: emptyCounts(),
    total: 0,
    first: -1,
    markers: [],
  }));
  let tallest = 0;
  entries.forEach((entry, index) => {
    const at = entry.kind === 'line' ? entry.at : entry.receivedAt;
    const bucket = buckets[Math.floor((at - start) / bucketMs)];
    if (!bucket) return;
    if (entry.kind === 'marker') {
      bucket.markers.push(entry);
      return;
    }
    bucket.counts[levelOf(entry) ?? 'none'] += 1;
    bucket.total += 1;
    if (bucket.first < 0) bucket.first = index;
    if (bucket.total > tallest) tallest = bucket.total;
  });
  return { start, end: start + count * bucketMs, bucketMs, buckets, max: tallest };
}

export function formatBucketWidth(ms: number): string {
  if (ms < 60_000) return `${ms / 1000} s`;
  if (ms < 3_600_000) return `${ms / 60_000} min`;
  if (ms < 86_400_000) return `${ms / 3_600_000} h`;
  return `${ms / 86_400_000} d`;
}

// ---- Variable-height rows ----

/** A row taller than the base height (an expanded field table), by index; sorted by idx. */
export interface TallRow {
  idx: number;
  extra: number;
}

export function rowTop(idx: number, rowHeight: number, tall: readonly TallRow[]): number {
  let offset = 0;
  for (const row of tall) {
    if (row.idx >= idx) break;
    offset += row.extra;
  }
  return idx * rowHeight + offset;
}

/** Index of the row that covers vertical position `y`. */
export function rowAt(y: number, rowHeight: number, tall: readonly TallRow[]): number {
  let offset = 0;
  for (const row of tall) {
    const top = row.idx * rowHeight + offset;
    if (y < top) break;
    if (y < top + rowHeight + row.extra) return row.idx;
    offset += row.extra;
  }
  return Math.max(0, Math.floor((y - offset) / rowHeight));
}

export function rowsHeight(count: number, rowHeight: number, tall: readonly TallRow[]): number {
  return count * rowHeight + tall.reduce((sum, row) => (row.idx < count ? sum + row.extra : sum), 0);
}
