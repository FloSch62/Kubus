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
  notice: 'info',
  warn: 'warn',
  warning: 'warn',
  wrn: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'error',
  severe: 'error',
  critical: 'error',
  panic: 'error',
};

// klog/glog prefix: "I0703 12:00:00.000000 ..."
const KLOG_LEVELS: Record<string, LogLevel> = { I: 'info', W: 'warn', E: 'error', F: 'error' };
const KLOG_RE = /^([IWEF])\d{4}\s/;
// JSON `"level":"info"` / logfmt `level=info` (also severity/lvl keys).
const STRUCTURED_RE = /(?:"(?:level|severity|lvl|log\.level)"\s*:\s*"?|\b(?:level|lvl|severity)=["']?)([a-zA-Z]+)/i;
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
  if (structured) return LEVEL_ALIASES[structured[1]!.toLowerCase()];
  const word = WORD_RE.exec(head);
  if (word) return LEVEL_ALIASES[word[1]!.toLowerCase()];
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
