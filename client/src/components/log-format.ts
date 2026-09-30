/**
 * Log line presentation: ANSI SGR parsing plus lightweight JSON / logfmt
 * tokenizing. Pure functions — parsing happens per visible row and results
 * are cached by the caller.
 */

export interface Seg {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  cls?: 'key' | 'str' | 'num' | 'bool' | 'punct';
  /** A level tag: drawn as a small filled label, never split by find marks. */
  tag?: boolean;
}

// oxlint-disable-next-line no-control-regex -- ESC is intentional: this expression parses ANSI sequences.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/;
// oxlint-disable-next-line no-control-regex -- ESC is intentional: this expression parses ANSI sequences.
const ANSI_RE_G = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(line: string): string {
  return ANSI_RE.test(line) ? line.replace(ANSI_RE_G, '') : line;
}

// 16-color palette tuned for the viewer's dark background.
const BASE_COLORS = [
  '#6b7089', // black
  '#f7768e', // red
  '#9ece6a', // green
  '#e0af68', // yellow
  '#7aa2f7', // blue
  '#bb9af7', // magenta
  '#7dcfff', // cyan
  '#d4d4da', // white
  '#7c819c', // bright black
  '#ff8fa3', // bright red
  '#b9e07f', // bright green
  '#f0c078', // bright yellow
  '#91b4ff', // bright blue
  '#cbb1f9', // bright magenta
  '#99dcff', // bright cyan
  '#ffffff', // bright white
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function color256(n: number): string {
  if (n < 16) return BASE_COLORS[n]!;
  if (n < 232) {
    const i = n - 16;
    const r = CUBE_LEVELS[Math.floor(i / 36)]!;
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6]!;
    const b = CUBE_LEVELS[i % 6]!;
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + 10 * (n - 232);
  return `rgb(${v},${v},${v})`;
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      state.fg = state.bg = undefined;
      state.bold = state.dim = false;
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 22) state.bold = state.dim = false;
    else if (p >= 30 && p <= 37) state.fg = BASE_COLORS[p - 30];
    else if (p >= 90 && p <= 97) state.fg = BASE_COLORS[p - 90 + 8];
    else if (p === 39) state.fg = undefined;
    else if (p >= 40 && p <= 47) state.bg = BASE_COLORS[p - 40];
    else if (p >= 100 && p <= 107) state.bg = BASE_COLORS[p - 100 + 8];
    else if (p === 49) state.bg = undefined;
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        state[target] = color256(params[i + 2]!);
        i += 2;
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        state[target] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
    }
  }
}

// oxlint-disable-next-line no-control-regex -- ESC is intentional: this expression parses ANSI sequences.
const CSI_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;

function parseAnsi(line: string): Seg[] {
  const segs: Seg[] = [];
  const state: SgrState = {};
  let last = 0;
  const re = CSI_RE;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  const emit = (text: string) => {
    if (!text) return;
    segs.push({ text, fg: state.fg, bg: state.bg, bold: state.bold || undefined, dim: state.dim || undefined });
  };
  while ((m = re.exec(line))) {
    emit(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === 'm') {
      applySgr(state, m[1] ? m[1].split(';').map((s) => Number(s || '0')) : [0]);
    }
    // other CSI codes (cursor movement etc.) are dropped
  }
  emit(line.slice(last));
  return segs.length ? segs : [{ text: '' }];
}

const NUMBER_CHAR_RE = /[0-9.eE+-]/;
const LOWER_CHAR_RE = /[a-z]/;

/** Tokenize a JSON document, keeping output text byte-identical to input. */
function parseJsonSegs(line: string): Seg[] | undefined {
  const trimmed = line.trimStart();
  if (line.length > 16_384 || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const segs: Seg[] = [];
  let i = 0;
  const n = line.length;
  let plainStart = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) segs.push({ text: line.slice(plainStart, end) });
  };
  const push = (start: number, end: number, cls: Seg['cls']) => {
    flushPlain(start);
    segs.push({ text: line.slice(start, end), cls });
    plainStart = end;
  };
  while (i < n) {
    const ch = line[i]!;
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (line[i] === '\\') i += 2;
        else if (line[i] === '"') {
          i++;
          break;
        } else i++;
      }
      // a string followed by ':' is an object key
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push(start, i, line[j] === ':' ? 'key' : 'str');
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      i++;
      while (i < n && NUMBER_CHAR_RE.test(line[i]!)) i++;
      push(start, i, 'num');
    } else if (LOWER_CHAR_RE.test(ch)) {
      const start = i;
      while (i < n && LOWER_CHAR_RE.test(line[i]!)) i++;
      const word = line.slice(start, i);
      push(start, i, word === 'true' || word === 'false' || word === 'null' ? 'bool' : 'punct');
    } else {
      i++;
    }
  }
  flushPlain(n);
  return segs;
}

const LOGFMT_PAIR = /([A-Za-z0-9_.@/-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
const LOGFMT_NUM_RE = /^-?[0-9.]+$/;

function parseLogfmtSegs(line: string): Seg[] | undefined {
  // Require at least two key=value pairs to avoid false positives.
  const pairs = [...line.matchAll(LOGFMT_PAIR)];
  if (pairs.length < 2) return undefined;
  const segs: Seg[] = [];
  let last = 0;
  for (const m of pairs) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index) });
    segs.push({ text: m[1]!, cls: 'key' });
    segs.push({ text: '=', cls: 'punct' });
    const value = m[2]!;
    if (value) segs.push({ text: value, cls: LOGFMT_NUM_RE.test(value) ? 'num' : 'str' });
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push({ text: line.slice(last) });
  return segs;
}

export interface LogField {
  key: string;
  value: string;
  kind: 'str' | 'num' | 'bool' | 'null' | 'json';
}

export interface LogFields {
  format: 'json' | 'logfmt';
  fields: LogField[];
  /** logfmt: the text around the key=value pairs, if any. */
  text?: string;
}

const MAX_FIELDS = 200;
const MAX_FIELD_DEPTH = 6;

function flattenJson(value: unknown, key: string, out: LogField[], depth: number): void {
  if (out.length >= MAX_FIELDS) return;
  if (value === null) {
    out.push({ key, value: 'null', kind: 'null' });
  } else if (typeof value === 'string') {
    out.push({ key, value, kind: 'str' });
  } else if (typeof value === 'number') {
    out.push({ key, value: String(value), kind: 'num' });
  } else if (typeof value === 'boolean') {
    out.push({ key, value: String(value), kind: 'bool' });
  } else if (Array.isArray(value)) {
    // Scalar lists read best inline; lists of objects get one row per field.
    if (depth >= MAX_FIELD_DEPTH || value.every((item) => item === null || typeof item !== 'object')) {
      out.push({ key, value: JSON.stringify(value), kind: 'json' });
    } else {
      value.forEach((item, index) => flattenJson(item, `${key}[${index}]`, out, depth + 1));
    }
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length || depth >= MAX_FIELD_DEPTH) {
      out.push({ key, value: JSON.stringify(value), kind: 'json' });
    } else {
      for (const [child, childValue] of entries) flattenJson(childValue, key ? `${key}.${child}` : child, out, depth + 1);
    }
  }
}

function unquoteLogfmt(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, value.endsWith('"') ? -1 : undefined);
  }
}

/**
 * Split a structured line into a field table: a JSON object (nested keys
 * flattened to dotted paths) or logfmt key=value pairs. Plain lines return
 * undefined.
 */
export function parseFields(line: string): LogFields | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith('{') && line.length <= 65_536) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) {
      const fields: LogField[] = [];
      flattenJson(parsed, '', fields, 0);
      return fields.length ? { format: 'json', fields } : undefined;
    }
  }
  const pairs = [...line.matchAll(LOGFMT_PAIR)];
  if (pairs.length < 2) return undefined;
  const fields: LogField[] = [];
  let text = '';
  let last = 0;
  for (const match of pairs) {
    text += line.slice(last, match.index);
    last = match.index + match[0].length;
    if (fields.length >= MAX_FIELDS) continue;
    const raw = match[2]!;
    const value = unquoteLogfmt(raw);
    const kind = raw.startsWith('"') ? 'str' : LOGFMT_NUM_RE.test(value) ? 'num' : value === 'true' || value === 'false' ? 'bool' : 'str';
    fields.push({ key: match[1]!, value, kind });
  }
  text = (text + line.slice(last)).trim();
  return { format: 'logfmt', fields, text: text || undefined };
}

const MESSAGE_KEYS = ['msg', 'message', 'log', 'event', '@m', '@message', 'M'];
const TIME_KEYS = ['time', 'timestamp', 'ts', '@timestamp', '@t', 't', 'T'];
const LEVEL_KEYS = ['level', 'lvl', 'severity', '@l', 'L', 'log.level', 'levelname'];

export interface MessageView {
  message?: string;
  /** The fields not shown in their own place. */
  rest: LogField[];
  /** The line's own level field, shown as a tag. */
  level?: LogField;
  /** The line's own time field, shown in front when the time column is off. */
  time?: LogField;
}

const pickField = (fields: LogField[], keys: string[], ok: (field: LogField) => boolean) =>
  keys.map((key) => fields.find((field) => field.key === key && ok(field))).find(Boolean);

/**
 * Message-first view of a structured line: the human message, then the
 * remaining fields. The level and time fields are picked out so the row can
 * show them in their own place; logfmt text around the pairs (a leading
 * timestamp, a `[main]` tag) stays in front of the message.
 */
export function splitMessage(parsed: LogFields): MessageView {
  const messageField = pickField(parsed.fields, MESSAGE_KEYS, (field) => field.kind === 'str');
  // A number only counts when it maps to a level (`"level":30`), so `level=2` in a
  // compression log stays an ordinary field.
  const level = pickField(parsed.fields, LEVEL_KEYS, (field) => field.kind === 'str' || (field.kind === 'num' && levelTag(field.value).level !== undefined));
  const time = pickField(parsed.fields, TIME_KEYS, (field) => field.kind === 'str' || field.kind === 'num');
  const message = [parsed.text, messageField?.value].filter(Boolean).join(' ');
  const rest = parsed.fields.filter((field) => field !== messageField && field !== level && field !== time);
  return { message: message || undefined, rest, level, time };
}

/** The level named by a structured line's own (top-level) level field. */
export function fieldLevel(parsed: LogFields): LogLevel | undefined {
  const field = pickField(parsed.fields, LEVEL_KEYS, (f) => f.kind === 'str' || f.kind === 'num');
  return field ? levelTag(field.value).level : undefined;
}

/**
 * A structured time value as a date: RFC 3339 and similar strings, or epoch
 * numbers in seconds (zap), milliseconds (pino), microseconds or nanoseconds.
 */
export function parseLineTime(value: string): Date | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    ms = n >= 1e17 ? n / 1e6 : n >= 1e14 ? n / 1e3 : n >= 1e11 ? n : n * 1000;
  } else {
    // Date.parse is lenient ("worker 3" is a date in 2001): only try text that
    // starts like a date or names a month.
    if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) && !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*\d{1,2}:\d{2}/i.test(trimmed)) return undefined;
    // "2026-09-30 08:00:00,123" (Python, Java) → a separator Date.parse accepts.
    ms = Date.parse(trimmed.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2').replace(/(\d{2}:\d{2}:\d{2}),(\d+)/, '$1.$2'));
  }
  // Plausible wall-clock times only; anything else is shown as written.
  if (!Number.isFinite(ms) || ms < 946_684_800_000 || ms > 4_102_444_800_000) return undefined;
  return new Date(ms);
}

/** Parse a raw log line into styled segments (ANSI > JSON > logfmt > plain). */
export function parseLine(line: string): Seg[] {
  if (ANSI_RE.test(line)) return parseAnsi(line);
  return parseJsonSegs(line) ?? parseLogfmtSegs(line) ?? [{ text: line }];
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

const LEVEL_ALIASES: Record<string, LogLevel> = {
  trace: 'trace',
  debug: 'debug',
  dbg: 'debug',
  info: 'info',
  inf: 'info',
  information: 'info',
  informational: 'info',
  notice: 'info',
  warn: 'warn',
  warning: 'warn',
  wrn: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'error',
  severe: 'error',
  critical: 'error',
  crit: 'error',
  panic: 'error',
  dpanic: 'error',
  alert: 'error',
  emergency: 'error',
  emerg: 'error',
};

/** Tag text for level names that differ from their bucket (FATAL is not ERROR). */
const LEVEL_LABELS: Record<string, string> = {
  dbg: 'DEBUG',
  inf: 'INFO',
  information: 'INFO',
  informational: 'INFO',
  warning: 'WARN',
  wrn: 'WARN',
  err: 'ERROR',
  critical: 'CRIT',
  emergency: 'EMERG',
};

// Numeric levels: pino and bunyan (10 trace … 60 fatal), Cloud Logging
// severities (100 debug … 800 emergency). Single digits are left alone: in
// `level=2` they are far more often a setting than a syslog priority.
const PINO_LEVELS: Array<[number, string]> = [
  [60, 'fatal'],
  [50, 'error'],
  [40, 'warn'],
  [30, 'info'],
  [20, 'debug'],
  [10, 'trace'],
];
const CLOUD_LEVELS = ['default', 'debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg'];

function numericLevelName(n: number): string | undefined {
  if (n < 10) return undefined;
  if (n < 100) return PINO_LEVELS.find(([min]) => n >= min)?.[1];
  return CLOUD_LEVELS[Math.min(8, Math.floor(n / 100))];
}

export interface LevelTag {
  /** What the tag reads: INFO, FATAL, CRIT, or the value as written. */
  label: string;
  /** The filter bucket (and colour); undefined for DEFAULT and unknown values. */
  level?: LogLevel;
}

/**
 * The tag for a structured level value: names are normalised (warning → WARN),
 * numeric levels are mapped, fatal/panic/critical keep their own word, and
 * anything unknown is shown as written.
 */
export function levelTag(value: string): LevelTag {
  const trimmed = value.trim();
  const name = /^\d+$/.test(trimmed) ? numericLevelName(Number(trimmed)) : trimmed.toLowerCase();
  // Own keys only: a line may well say `"level":"constructor"`.
  if (name && (Object.hasOwn(LEVEL_ALIASES, name) || name === 'default')) {
    return { label: (Object.hasOwn(LEVEL_LABELS, name) ? LEVEL_LABELS[name] : undefined) ?? name.toUpperCase(), level: LEVEL_ALIASES[name] };
  }
  return { label: trimmed.toUpperCase().slice(0, 7) };
}

// klog/glog prefix: "I0703 12:00:00.000000 ..."
const KLOG_LEVELS: Record<string, LogLevel> = { I: 'info', W: 'warn', E: 'error', F: 'error' };
const KLOG_RE = /^([IWEF])\d{4}\s/;
// JSON `"level":"info"` / `"level":30` / logfmt `level=info` (also severity/lvl
// keys). Numbers only count in JSON, where pino and bunyan write them.
const STRUCTURED_RE = /"(?:level|severity|lvl|log\.level)"\s*:\s*(?:"([a-zA-Z]+)|(\d+))|\b(?:level|lvl|severity)=["']?([a-zA-Z]+)/i;
// Bare or bracketed level words near the start of the line.
const WORD_RE = /(?:^|[\s[(<|:])(trace|debug|dbg|info|inf|notice|warn|warning|wrn|error|err|fatal|severe|critical|panic)(?=[\s\])>|:,/-]|$)/i;

/**
 * Best-effort severity detection for a log line (pass an ANSI-stripped
 * line). Only the head of the line is scanned — levels live there, and it
 * avoids false positives from message payloads.
 */
export function detectLevel(line: string): LogLevel | undefined {
  const klog = KLOG_RE.exec(line);
  if (klog) return KLOG_LEVELS[klog[1]!];
  const head = line.slice(0, 200);
  const structured = STRUCTURED_RE.exec(head);
  if (structured) return levelTag(structured[1] ?? structured[2] ?? structured[3]!).level;
  const word = WORD_RE.exec(head);
  if (word) return levelTag(word[1]!).level;
  return undefined;
}

export interface MarkedSeg extends Seg {
  mark?: boolean;
}

/** Split segments so occurrences of `query` (case-insensitive) carry mark=true. */
export function markSegs(segs: Seg[], query: string): MarkedSeg[] {
  if (!query) return segs;
  const q = query.toLowerCase();
  const out: MarkedSeg[] = [];
  for (const seg of segs) {
    if (seg.tag) {
      out.push(seg);
      continue;
    }
    const lower = seg.text.toLowerCase();
    let pos = 0;
    for (;;) {
      const hit = lower.indexOf(q, pos);
      if (hit === -1) break;
      if (hit > pos) out.push({ ...seg, text: seg.text.slice(pos, hit) });
      out.push({ ...seg, text: seg.text.slice(hit, hit + q.length), mark: true });
      pos = hit + q.length;
    }
    if (pos < seg.text.length) out.push({ ...seg, text: seg.text.slice(pos) });
  }
  return out;
}
