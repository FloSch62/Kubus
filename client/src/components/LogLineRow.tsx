import { memo, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import type { TsMode } from '../state/log-prefs.js';
import { detectLevel, markSegs, parseFields, parseLine, stripAnsi, type LogFields, type LogLevel, type Seg } from './log-format.js';
import type { LogEntry, LogLine, LogMarkerTone } from './log-tools.js';
import { LogFieldsTable } from './LogFields.js';

/*
 * One row of the log body: a line (source, time, highlighted text, and for
 * JSON or logfmt lines a toggle that expands a field table) or a marker.
 */

const CLS_COLORS: Record<NonNullable<Seg['cls']>, string> = {
  key: '#7aa2f7',
  str: '#9ece6a',
  num: '#e0af68',
  bool: '#bb9af7',
  punct: '#6b7089',
};

const segCache = new WeakMap<LogLine, Seg[]>();
const stripCache = new WeakMap<LogLine, string>();
const levelCache = new WeakMap<LogLine, LogLevel | null>();
const fieldsCache = new WeakMap<LogLine, LogFields | null>();

/** Marker colours on the dark log body. */
export const MARKER_COLOR: Record<LogMarkerTone, string> = {
  manual: '#bb9af7',
  warning: '#e0af68',
  success: '#9ece6a',
  joined: '#73daca',
  left: '#9aa0b5',
};

const MARKER_ICON: Record<LogMarkerTone, typeof FlagOutlinedIcon> = {
  manual: FlagOutlinedIcon,
  warning: LinkOffIcon,
  success: CheckCircleOutlinedIcon,
  joined: PlayCircleOutlinedIcon,
  left: StopCircleOutlinedIcon,
};

/** Row tint for lines that demand attention while scanning. */
const LEVEL_ROW_TINT: Partial<Record<LogLevel, string>> = {
  error: 'rgba(247,118,142,0.08)',
  warn: 'rgba(224,175,104,0.07)',
};

export function strippedOf(l: LogLine): string {
  let s = stripCache.get(l);
  if (s === undefined) {
    s = stripAnsi(l.line);
    stripCache.set(l, s);
  }
  return s;
}

function segsOf(l: LogLine): Seg[] {
  let segs = segCache.get(l);
  if (!segs) {
    segs = parseLine(l.line);
    segCache.set(l, segs);
  }
  return segs;
}

export function levelOf(l: LogLine): LogLevel | undefined {
  let level = levelCache.get(l);
  if (level === undefined) {
    level = detectLevel(strippedOf(l)) ?? null;
    levelCache.set(l, level);
  }
  return level ?? undefined;
}

export function fieldsOf(l: LogLine): LogFields | undefined {
  let fields = fieldsCache.get(l);
  if (fields === undefined) {
    fields = parseFields(strippedOf(l)) ?? null;
    fieldsCache.set(l, fields);
  }
  return fields ?? undefined;
}

export const localLogTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });

export function fmtTs(ts: string, mode: TsMode): string {
  if (mode === 'utc') return `${ts.slice(11, 23)}Z`;
  const d = new Date(ts);
  return `${Number.isNaN(d.getTime()) ? 'Invalid Date' : localLogTime.format(d)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Row styles, applied once on the scroll container. Rows are plain elements
 * with these class names: every 120 ms flush re-renders the rows in view, so
 * per-row style objects would cost more than the lines themselves.
 */
export const LOG_ROW_CSS = {
  '@keyframes kubus-log-flash': {
    from: { backgroundColor: 'rgba(122,162,247,0.35)', boxShadow: 'inset 3px 0 0 #7aa2f7' },
    to: { backgroundColor: 'rgba(122,162,247,0)', boxShadow: 'inset 3px 0 0 rgba(122,162,247,0)' },
  },
  '& .kl-row': { position: 'absolute', left: 0, right: 0 },
  '& .kl-line': { display: 'flex', gap: '8px', padding: '0 8px', whiteSpace: 'pre' },
  '& .kl-wrap': { padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', contentVisibility: 'auto' },
  '& .kl-tint-error': { backgroundColor: LEVEL_ROW_TINT.error },
  '& .kl-tint-warn': { backgroundColor: LEVEL_ROW_TINT.warn },
  '& .kl-line:hover, & .kl-wrap:hover': { backgroundColor: 'rgba(255,255,255,0.04)' },
  '& .kl-expandable': { cursor: 'pointer' },
  '& .kl-flash': { animation: 'kubus-log-flash 1.6s ease-out' },
  '& .kl-gutter': { width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'top' },
  '& .kl-toggle': { all: 'unset', cursor: 'pointer', display: 'inline-flex', color: '#6b7089', borderRadius: '2px' },
  '& .kl-toggle:hover': { color: '#c0caf5' },
  '& .kl-toggle:focus-visible': { outline: '1px solid #7aa2f7' },
  '& .kl-toggle[aria-expanded="true"]': { color: '#7aa2f7' },
  '& .kl-toggle svg': { transition: 'transform 120ms' },
  '& .kl-toggle[aria-expanded="true"] svg': { transform: 'rotate(90deg)' },
  '& .kl-src': { flexShrink: 0 },
  '& .kl-ts': { color: '#6b7089', flexShrink: 0, minWidth: '12ch' },
  '& .kl-line .kl-msg': { overflow: 'hidden', textOverflow: 'ellipsis' },
  '& .kl-wrap .kl-gutter': { marginRight: '4px' },
  '& .kl-wrap .kl-src, & .kl-wrap .kl-ts': { marginRight: '8px' },
} as const;

interface LineRowProps {
  line: LogEntry;
  idx: number;
  top: number;
  wrap: boolean;
  showPod: boolean;
  showSource: boolean;
  podColor?: string;
  tsMode: TsMode;
  highlight: boolean;
  find: string;
  isCurrent: boolean;
  rowHeight: number;
  expanded: boolean;
  flash: boolean;
  /** Scroll the freshly expanded field table into view. */
  reveal: boolean;
  onToggle: (line: LogLine) => void;
  onMeasure: (line: LogLine, extra: number) => void;
  onRevealed: () => void;
}

interface FieldsBlockProps {
  line: LogLine;
  /** Report the height (virtualized layout) so the rows below move down. */
  measure: boolean;
  reveal: boolean;
  onMeasure: (line: LogLine, extra: number) => void;
  onRevealed: () => void;
  children: React.ReactNode;
}

/** The expanded field table under its line. */
function FieldsBlock({ line, measure, reveal, onMeasure, onRevealed, children }: FieldsBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !measure) return;
    const report = () => onMeasure(line, element.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [line, measure, onMeasure]);
  useEffect(() => {
    if (!reveal) return;
    // Two frames: the rows below have moved down to make room by then.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        ref.current?.scrollIntoView({ block: 'nearest' });
        onRevealed();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [onRevealed, reveal]);
  return (
    <div ref={ref} style={{ padding: '2px 0 6px' }}>
      {children}
    </div>
  );
}

const CHEVRON = (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
  </svg>
);

export const LineRow = memo(function LineRow({
  line,
  idx,
  top,
  wrap,
  showPod,
  showSource,
  podColor,
  tsMode,
  highlight,
  find,
  isCurrent,
  rowHeight,
  expanded,
  flash,
  reveal,
  onToggle,
  onMeasure,
  onRevealed,
}: LineRowProps) {
  if (line.kind === 'marker') {
    const color = MARKER_COLOR[line.tone];
    const Icon = MARKER_ICON[line.tone];
    return (
      <Box
        data-idx={idx}
        sx={
          wrap
            ? { minHeight: rowHeight, px: 1, display: 'flex', alignItems: 'center', gap: 1, color, contentVisibility: 'auto', containIntrinsicSize: `auto ${rowHeight}px` }
            : { position: 'absolute', top, left: 0, right: 0, height: rowHeight, px: 1, display: 'flex', alignItems: 'center', gap: 1, color }
        }
      >
        <Divider sx={{ flex: 1, borderColor: color, opacity: 0.55 }} />
        <Icon sx={{ fontSize: 14 }} />
        <Box component="span" sx={{ fontSize: '0.9em', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {line.label}
        </Box>
        <Divider sx={{ flex: 1, borderColor: color, opacity: 0.55 }} />
      </Box>
    );
  }

  const segs = highlight ? segsOf(line) : [{ text: strippedOf(line) }];
  const marked = find ? markSegs(segs, find) : segs;
  const level = levelOf(line);
  const tint = level === 'error' || level === 'warn' ? ` kl-tint-${level}` : '';
  const sourceLabel = showPod ? [line.pod, line.container].filter(Boolean).join('/') : line.container;
  const fields = fieldsOf(line);
  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    onToggle(line);
  };
  const content = (
    <>
      <span className="kl-gutter">
        {fields ? (
          <button
            type="button"
            className="kl-toggle"
            aria-label={expanded ? 'Collapse fields' : `Expand ${fields.fields.length} fields`}
            aria-expanded={expanded}
            onClick={toggle}
          >
            {CHEVRON}
          </button>
        ) : null}
      </span>
      {showSource && (
        <span className="kl-src" style={{ color: podColor }}>
          {sourceLabel}
        </span>
      )}
      {tsMode !== 'off' && <span className="kl-ts">{line.ts ? fmtTs(line.ts, tsMode) : ''}</span>}
      <span className="kl-msg">
        {marked.map((seg, i) => {
          const mark = 'mark' in seg && seg.mark;
          return (
            <span
              key={i}
              style={{
                color: mark && isCurrent ? '#1a1a1e' : (seg.fg ?? (seg.cls ? CLS_COLORS[seg.cls] : undefined)),
                backgroundColor: mark ? (isCurrent ? '#e0af68' : 'rgba(224,175,104,0.35)') : seg.bg,
                fontWeight: seg.bold ? 700 : undefined,
                opacity: seg.dim ? 0.6 : undefined,
              }}
            >
              {seg.text}
            </span>
          );
        })}
      </span>
    </>
  );
  const table =
    expanded && fields ? (
      <FieldsBlock line={line} measure={!wrap} reveal={reveal} onMeasure={onMeasure} onRevealed={onRevealed}>
        <LogFieldsTable parsed={fields} line={strippedOf(line)} />
      </FieldsBlock>
    ) : null;
  const extra = `${fields ? ' kl-expandable' : ''}${flash ? ' kl-flash' : ''}`;
  if (wrap) {
    return (
      <div data-idx={idx} data-expandable={fields ? '' : undefined} className={`kl-wrap${tint}${extra}`} style={{ containIntrinsicSize: `auto ${rowHeight}px` }}>
        {content}
        {table}
      </div>
    );
  }
  return (
    <div data-idx={idx} className={`kl-row${tint}${flash ? ' kl-flash' : ''}`} style={{ top }}>
      <div data-expandable={fields ? '' : undefined} className={`kl-line${fields ? ' kl-expandable' : ''}`} style={{ height: rowHeight }}>
        {content}
      </div>
      {table}
    </div>
  );
});
