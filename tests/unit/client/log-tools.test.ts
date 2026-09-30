import { describe, expect, it } from 'vitest';
import { detectLevel, stripAnsi } from '../../../client/src/components/log-format';
import {
  buildHistogram,
  formatBucketWidth,
  formatLogExport,
  isValidRegex,
  logLine,
  mergeByTime,
  rowAt,
  rowsHeight,
  rowTop,
  shortPodLabels,
  textMatcher,
  type LogEntry,
  type LogLine,
  type LogMarker,
} from '../../../client/src/components/log-tools';

const levelOf = (line: LogLine) => detectLevel(stripAnsi(line.line));

function line(text: string, ts: string, pod = 'web-a', container = 'app'): LogLine {
  return logLine(pod, container, text, ts, 0);
}

function marker(label: string, receivedAt = 0): LogMarker {
  return { kind: 'marker', label, tone: 'manual', receivedAt };
}

const texts = (entries: readonly LogEntry[]) => entries.map((entry) => (entry.kind === 'line' ? entry.line : `[${entry.label}]`));

describe('logLine', () => {
  it('parses the timestamp and falls back to arrival time', () => {
    expect(logLine('p', 'c', 'x', '2026-07-22T12:00:00.123456789Z', 5).at).toBe(Date.parse('2026-07-22T12:00:00.123Z'));
    expect(logLine('p', 'c', 'x', undefined, 5).at).toBe(5);
    expect(logLine('p', 'c', 'x', 'garbage', 7).at).toBe(7);
  });
});

describe('mergeByTime', () => {
  it('appends in-order batches as they are', () => {
    const existing = [line('a', '2026-07-22T12:00:00Z')];
    const merged = mergeByTime(existing, [line('b', '2026-07-22T12:00:01Z')]);
    expect(texts(merged)).toEqual(['a', 'b']);
    expect(merged).not.toBe(existing);
  });

  it('interleaves a later backlog with the lines already shown', () => {
    const existing = [line('a1', '2026-07-22T12:00:01Z'), line('a3', '2026-07-22T12:00:03Z')];
    const merged = mergeByTime(existing, [line('b2', '2026-07-22T12:00:02Z', 'web-b'), line('b0', '2026-07-22T12:00:00Z', 'web-b')]);
    expect(texts(merged)).toEqual(['b0', 'a1', 'b2', 'a3']);
  });

  it('keeps arrival order for equal timestamps', () => {
    const merged = mergeByTime([line('x', '2026-07-22T12:00:00Z')], [line('y', '2026-07-22T12:00:00Z'), line('z', '2026-07-22T12:00:00Z')]);
    expect(texts(merged)).toEqual(['x', 'y', 'z']);
  });

  it('never moves lines across a marker', () => {
    const existing: LogEntry[] = [line('a2', '2026-07-22T12:00:02Z'), marker('restart')];
    const merged = mergeByTime(existing, [line('b1', '2026-07-22T12:00:01Z'), marker('mark'), line('c0', '2026-07-22T12:00:00Z')]);
    expect(texts(merged)).toEqual(['a2', '[restart]', 'b1', '[mark]', 'c0']);
  });
});

describe('textMatcher', () => {
  it('returns nothing for an empty pattern', () => {
    expect(textMatcher('', false)).toBeUndefined();
  });

  it('matches regexes with or without case', () => {
    expect(textMatcher('^get /health', false)!('GET /healthz')).toBe(true);
    expect(textMatcher('^get /health', true)!('GET /healthz')).toBe(false);
  });

  it('falls back to substring matching for invalid regexes', () => {
    expect(isValidRegex('[')).toBe(false);
    expect(textMatcher('a[b', false)!('xA[By')).toBe(true);
    expect(textMatcher('a[b', true)!('xA[By')).toBe(false);
    expect(textMatcher('A[b', true)!('xA[by')).toBe(true);
  });
});

describe('formatLogExport', () => {
  const entries: LogEntry[] = [
    line('\u001b[31mERROR\u001b[0m boom', '2026-07-22T12:00:00.000000001Z'),
    marker('Marker · 12:00'),
    logLine('web-b', 'app', 'plain', undefined, Date.parse('2026-07-22T12:00:01Z')),
  ];
  const options = { showSource: true, showPod: true, levelOf };

  it('renders the on-screen layout, markers included', () => {
    expect(formatLogExport(entries, 'shown', { ...options, formatTs: (ts) => ts.slice(11, 19) }).split('\n')).toEqual([
      'web-a/app 12:00:00 ERROR boom',
      '--- Marker · 12:00 ---',
      'web-b/app plain',
    ]);
    expect(formatLogExport(entries, 'shown', { ...options, showSource: false })).toBe('ERROR boom\n--- Marker · 12:00 ---\nplain');
    // In the message view the export writes what the view shows.
    expect(formatLogExport(entries, 'shown', { ...options, showSource: false, displayText: (line) => `shown ${line.pod}` })).toBe(
      'shown web-a\n--- Marker · 12:00 ---\nshown web-b',
    );
  });

  it('keeps raw lines exactly as written', () => {
    expect(formatLogExport(entries, 'raw', options)).toBe('\u001b[31mERROR\u001b[0m boom\nplain');
  });

  it('prefixes RFC 3339 timestamps and sources', () => {
    expect(formatLogExport(entries, 'timestamps', options).split('\n')).toEqual([
      '2026-07-22T12:00:00.000000001Z [web-a/app] ERROR boom',
      '2026-07-22T12:00:01.000Z [web-b/app] plain',
    ]);
    expect(formatLogExport(entries.slice(0, 1), 'timestamps', { ...options, showSource: false })).toBe('2026-07-22T12:00:00.000000001Z ERROR boom');
  });

  it('writes one JSON object per line', () => {
    const rows = formatLogExport(entries, 'ndjson', options).split('\n').map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(rows).toEqual([
      { ts: '2026-07-22T12:00:00.000000001Z', pod: 'web-a', container: 'app', level: 'error', message: 'ERROR boom' },
      { ts: '2026-07-22T12:00:01.000Z', pod: 'web-b', container: 'app', message: 'plain' },
    ]);
  });
});

describe('buildHistogram', () => {
  it('returns nothing without lines', () => {
    expect(buildHistogram([marker('x')], 10, levelOf)).toBeUndefined();
  });

  it('buckets lines by a round width and counts levels', () => {
    const entries: LogEntry[] = [
      line('INFO a', '2026-07-22T12:00:00.500Z'),
      line('ERROR b', '2026-07-22T12:00:03Z'),
      line('plain', '2026-07-22T12:00:04Z'),
      { ...marker('joined'), receivedAt: Date.parse('2026-07-22T12:00:04.5Z') },
      line('WARN c', '2026-07-22T12:00:19Z'),
    ];
    const histogram = buildHistogram(entries, 5, levelOf)!;
    expect(histogram.bucketMs).toBe(5_000);
    expect(histogram.start).toBe(Date.parse('2026-07-22T12:00:00Z'));
    expect(histogram.buckets).toHaveLength(4);
    expect(histogram.max).toBe(3);
    const [first, second, , last] = histogram.buckets;
    expect(first).toMatchObject({ total: 3, first: 0, counts: { info: 1, error: 1, none: 1, warn: 0 } });
    expect(first!.markers.map((m) => m.label)).toEqual(['joined']);
    expect(second).toMatchObject({ total: 0, first: -1 });
    expect(last).toMatchObject({ total: 1, first: 4, counts: { warn: 1 } });
  });

  it('points each bucket at its first line in buffer order', () => {
    const entries = [line('x', '2026-07-22T12:00:08Z'), line('y', '2026-07-22T12:00:01Z'), line('z', '2026-07-22T12:00:02Z')];
    const histogram = buildHistogram(entries, 2, levelOf)!;
    expect(histogram.buckets.map((bucket) => bucket.first)).toEqual([1, 0]);
  });

  it('uses sub-second bars for a short burst', () => {
    const histogram = buildHistogram([line('a', '2026-07-22T12:00:00Z'), line('b', '2026-07-22T12:00:13Z')], 190, levelOf)!;
    expect(histogram.bucketMs).toBe(100);
    expect(histogram.buckets).toHaveLength(131);
    expect(formatBucketWidth(histogram.bucketMs)).toBe('0.1 s');
  });

  it('formats bucket widths', () => {
    expect(formatBucketWidth(1_000)).toBe('1 s');
    expect(formatBucketWidth(300_000)).toBe('5 min');
    expect(formatBucketWidth(7_200_000)).toBe('2 h');
    expect(formatBucketWidth(86_400_000)).toBe('1 d');
  });
});

describe('row offsets', () => {
  const tall = [
    { idx: 3, extra: 100 },
    { idx: 5, extra: 40 },
  ];

  it('places rows below expanded ones further down', () => {
    expect(rowTop(0, 20, tall)).toBe(0);
    expect(rowTop(3, 20, tall)).toBe(60);
    expect(rowTop(4, 20, tall)).toBe(180);
    expect(rowTop(6, 20, tall)).toBe(260);
    expect(rowsHeight(10, 20, tall)).toBe(340);
    expect(rowsHeight(4, 20, tall)).toBe(180);
  });

  it('finds the row covering a position', () => {
    expect(rowAt(50, 20, tall)).toBe(2);
    expect(rowAt(60, 20, tall)).toBe(3);
    expect(rowAt(179, 20, tall)).toBe(3);
    expect(rowAt(180, 20, tall)).toBe(4);
    expect(rowAt(230, 20, tall)).toBe(5);
    expect(rowAt(265, 20, tall)).toBe(6);
    expect(rowAt(-5, 20, [])).toBe(0);
  });
});

describe('shortPodLabels', () => {
  it('tags a workload by the random suffix and keeps short names whole', () => {
    const labels = shortPodLabels(['podinfo-5c7cdc845b-bp4xq', 'podinfo-5c7cdc845b-cpkl2', 'web-0', 'web-1']);
    expect(labels.get('podinfo-5c7cdc845b-bp4xq')).toBe('bp4xq');
    expect(labels.get('podinfo-5c7cdc845b-cpkl2')).toBe('cpkl2');
    expect(labels.get('web-0')).toBe('web-0');
  });

  it('takes more segments when the last one is too short or not unique', () => {
    const labels = shortPodLabels(['elasticsearch-master-0', 'elasticsearch-master-1', 'frontend-api-5c7c-abcde', 'backend-api-9f8e-abcde']);
    expect(labels.get('elasticsearch-master-0')).toBe('master-0');
    expect(labels.get('frontend-api-5c7c-abcde')).toBe('5c7c-abcde');
    expect(labels.get('backend-api-9f8e-abcde')).toBe('9f8e-abcde');
  });
});
