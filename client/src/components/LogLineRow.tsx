import { memo, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import type { LogView, TsMode } from '../state/log-prefs.js';
import { detectLevel, fieldLevel, levelTag, markSegs, parseFields, parseLine, parseLineTime, splitMessage, stripAnsi, type LogField, type LogFields, type LogLevel, type Seg } from './log-format.js';
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

/** Level word colours on the dark log body (the toolbar chips use theme-aware ones). */
export const LEVEL_TEXT_COLOR: Record<LogLevel, string> = {
  error: '#f7768e',
  warn: '#e0af68',
  info: '#7aa2f7',
  debug: '#9aa0b5',
  trace: '#6b7089',
};

/** Soft fills behind the level tags in the message view. */
const LEVEL_TAG_FILL: Record<LogLevel, string> = {
  error: 'rgba(247,118,142,0.16)',
  warn: 'rgba(224,175,104,0.16)',
  info: 'rgba(122,162,247,0.14)',
  debug: 'rgba(154,160,181,0.13)',
  trace: 'rgba(107,112,137,0.16)',
};
const NEUTRAL_TAG = { fg: '#a9b1d6', bg: 'rgba(154,160,181,0.13)' };

const FIELD_KEY_COLOR = '#6b7089';
const TIME_COLOR = '#6b7089';
const FIELD_VALUE_COLOR: Record<'str' | 'num' | 'bool' | 'null' | 'json', string> = {
  str: '#a9b1d6',
  num: '#e0af68',
  bool: '#bb9af7',
  null: '#6b7089',
  json: '#a9b1d6',
};

const segCache = new WeakMap<LogLine, Seg[]>();
// Two caches: with the line's own time in front (time column off) and without.
const messageSegCache = new WeakMap<LogLine, Seg[]>();
const messageTimedSegCache = new WeakMap<LogLine, Seg[]>();
const stripCache = new WeakMap<LogLine, string>();
const levelCache = new WeakMap<LogLine, LogLevel | null>();
const fieldsCache = new WeakMap<LogLine, LogFields | null>();
// displayTextOf per time mode: find and the filters read it for every line.
const displayTextCache = new WeakMap<LogLine, string>();
const displayTimedTextCache = new WeakMap<LogLine, string>();

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
    const text = strippedOf(l);
    // JSON can nest a `level` key ahead of the line's own; read the top-level
    // field so the tag, the row tint and the level filter agree.
    const fields = text.trimStart().startsWith('{') ? fieldsOf(l) : undefined;
    level = (fields && fieldLevel(fields)) ?? detectLevel(text) ?? null;
    levelCache.set(l, level);
  }
  return level ?? undefined;
}

/** A structured time field as the time column would show it, or as written when it is not a date. */
function lineTimeText(field: LogField): string {
  const date = parseLineTime(field.value);
  if (!date) return field.value.slice(0, 23);
  return `${localLogTime.format(date)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Message view of a JSON or logfmt line: the line's own time (when the time
 * column is off), its level as a tag, the message, then the other fields as
 * dimmed key=value pairs. Plain lines keep their raw text.
 */
function messageSegsOf(l: LogLine, fields: LogFields, level: LogLevel | undefined, withTime: boolean): Seg[] {
  const cache = withTime ? messageTimedSegCache : messageSegCache;
  let segs = cache.get(l);
  if (!segs) {
    const view = splitMessage(fields);
    segs = [];
    // A line without a time field falls back to when Kubernetes received it,
    // so the tags and messages of structured lines stay in one column.
    const time = view.time ? lineTimeText(view.time) : l.ts ? fmtTs(l.ts, 'local') : undefined;
    if (withTime && time) segs.push({ text: `${time.padEnd(12)} `, fg: TIME_COLOR });
    // Without a level field the level was read from the text; when the
    // message itself starts with that word ("INFO ready=true"), a tag repeats it.
    const tag = view.level
      ? levelTag(view.level.value)
      : level && !detectLevel(view.message ?? '')
        ? { label: level.toUpperCase(), level }
        : undefined;
    if (tag) {
      const tone = tag.level ? { fg: LEVEL_TEXT_COLOR[tag.level], bg: LEVEL_TAG_FILL[tag.level] } : NEUTRAL_TAG;
      segs.push({ text: tag.label.padEnd(5), fg: tone.fg, bg: tone.bg, bold: true, tag: true }, { text: ' ' });
    }
    if (view.message) segs.push({ text: view.message });
    for (const field of view.rest) {
      segs.push({ text: segs.length ? '  ' : '' }, { text: `${field.key}=`, fg: FIELD_KEY_COLOR }, { text: field.value, fg: FIELD_VALUE_COLOR[field.kind] });
    }
    cache.set(l, segs);
  }
  return segs;
}

/**
 * The line as the viewer shows it: the message view of a structured line, or
 * the raw text. Find, filters and the "As shown" export read this as well as
 * the raw text, so typing what is on screen matches.
 */
export function displayTextOf(l: LogLine, view: LogView, withTime: boolean): string {
  const fields = view === 'message' ? fieldsOf(l) : undefined;
  if (!fields) return strippedOf(l);
  const cache = withTime ? displayTimedTextCache : displayTextCache;
  let text = cache.get(l);
  if (text === undefined) {
    text = messageSegsOf(l, fields, levelOf(l), withTime)
      .map((seg) => seg.text)
      .join('')
      .trimEnd();
    cache.set(l, text);
  }
  return text;
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
  '& .kl-lvl': { padding: '0 4px', borderRadius: '3px', fontSize: '0.92em', letterSpacing: '0.02em' },
  '& .kl-current': { backgroundColor: 'rgba(224,175,104,0.10)' },
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
  /** Container name next to the pod (only when the tab spans several containers). */
  showContainer: boolean;
  /** Short unique label for the line's pod (see shortPodLabels). */
  podLabel?: string;
  podColor?: string;
  tsMode: TsMode;
  view: LogView;
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
  showContainer,
  podLabel,
  podColor,
  tsMode,
  view,
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

  const level = levelOf(line);
  const fields = fieldsOf(line);
  const messageView = view === 'message' && !!fields;
  const withTime = tsMode === 'off';
  const segs = messageView
    ? highlight
      ? messageSegsOf(line, fields, level, withTime)
      : [{ text: messageSegsOf(line, fields, level, withTime).map((seg) => seg.text).join('') }]
    : highlight
      ? segsOf(line)
      : [{ text: strippedOf(line) }];
  const marked = find ? markSegs(segs, find) : segs;
  const tint = level === 'error' || level === 'warn' ? ` kl-tint-${level}` : '';
  const sourceLabel = showPod ? [podLabel ?? line.pod, showContainer ? line.container : ''].filter(Boolean).join('/') : line.container;
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
        <span className="kl-src" style={{ color: podColor }} title={showPod ? `${line.pod}/${line.container}` : undefined}>
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
              className={seg.tag ? 'kl-lvl' : undefined}
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
  // The current find match gets a faint row tint too: the match may sit in a
  // field the message view does not show.
  const current = isCurrent ? ' kl-current' : '';
  const extra = `${fields ? ' kl-expandable' : ''}${flash ? ' kl-flash' : ''}${current}`;
  if (wrap) {
    return (
      <div data-idx={idx} data-expandable={fields ? '' : undefined} className={`kl-wrap${tint}${extra}`} style={{ containIntrinsicSize: `auto ${rowHeight}px` }}>
        {content}
        {table}
      </div>
    );
  }
  return (
    <div data-idx={idx} className={`kl-row${tint}${flash ? ' kl-flash' : ''}${current}`} style={{ top }}>
      <div data-expandable={fields ? '' : undefined} className={`kl-line${fields ? ' kl-expandable' : ''}`} style={{ height: rowHeight }}>
        {content}
      </div>
      {table}
    </div>
  );
});
