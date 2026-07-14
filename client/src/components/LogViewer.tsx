import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import WrapTextIcon from '@mui/icons-material/WrapText';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type { LogServerMessage } from '@kubus/shared';
import { wsUrl } from '../api/http.js';
import { useDockStore, type LogsTab } from '../state/dock.js';
import { copyToClipboard } from '../clipboard.js';
import { useLogPrefsStore, type TsMode } from '../state/log-prefs.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { detectLevel, LOG_LEVELS, markSegs, parseLine, stripAnsi, type LogLevel, type Seg } from './log-format.js';

interface LogLine {
  pod: string;
  container: string;
  ts?: string;
  line: string;
  receivedAt: number;
}

const POD_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];
const MAX_LINES = 20_000;
/** Virtualized row height for the default 12px mono font; scales with it. */
function rowHeightFor(fontSize: number): number {
  return fontSize + 8;
}
type LogTimeMode = 'live' | '10m' | '1h' | '6h' | '24h' | 'terminated';

const TIME_OPTIONS: Array<{ value: LogTimeMode; label: string; params: { follow: boolean; tail?: boolean; sinceSeconds?: number; previous?: boolean } }> = [
  { value: 'live', label: 'Live tail', params: { follow: true, tail: true } },
  { value: '10m', label: '10m ago', params: { follow: false, sinceSeconds: 10 * 60 } },
  { value: '1h', label: '1h ago', params: { follow: false, sinceSeconds: 60 * 60 } },
  { value: '6h', label: '6h ago', params: { follow: false, sinceSeconds: 6 * 60 * 60 } },
  { value: '24h', label: '24h ago', params: { follow: false, sinceSeconds: 24 * 60 * 60 } },
  { value: 'terminated', label: 'Terminated', params: { follow: false, tail: true, previous: true } },
];

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

const LEVEL_STYLE: Record<LogLevel, { letter: string; color: string }> = {
  error: { letter: 'E', color: '#f7768e' },
  warn: { letter: 'W', color: '#e0af68' },
  info: { letter: 'I', color: '#7aa2f7' },
  debug: { letter: 'D', color: '#9aa0b5' },
  trace: { letter: 'T', color: '#6b7089' },
};

/** Row tint for lines that demand attention while scanning. */
const LEVEL_ROW_TINT: Partial<Record<LogLevel, string>> = {
  error: 'rgba(247,118,142,0.08)',
  warn: 'rgba(224,175,104,0.07)',
};

function strippedOf(l: LogLine): string {
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

function levelOf(l: LogLine): LogLevel | undefined {
  let level = levelCache.get(l);
  if (level === undefined) {
    level = detectLevel(strippedOf(l)) ?? null;
    levelCache.set(l, level);
  }
  return level ?? undefined;
}

function fmtTs(ts: string, mode: TsMode): string {
  if (mode === 'utc') return `${ts.slice(11, 23)}Z`;
  const d = new Date(ts);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function initialTimeMode(tab: LogsTab): LogTimeMode {
  if (tab.previous) return 'terminated';
  if (tab.sinceSeconds === 10 * 60) return '10m';
  if (tab.sinceSeconds === 60 * 60) return '1h';
  if (tab.sinceSeconds === 6 * 60 * 60) return '6h';
  if (tab.sinceSeconds === 24 * 60 * 60) return '24h';
  return 'live';
}

function paramsForMode(mode: LogTimeMode): (typeof TIME_OPTIONS)[number]['params'] {
  return TIME_OPTIONS.find((opt) => opt.value === mode)?.params ?? TIME_OPTIONS[0]!.params;
}

export function LogViewer({ tab }: { tab: LogsTab }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<ReadonlySet<LogLevel>>(new Set());
  const [find, setFind] = useState('');
  const [cursor, setCursor] = useState(0);
  const [follow, setFollow] = useState(true);
  const [timeMode, setTimeMode] = useState<LogTimeMode>(() => initialTimeMode(tab));
  const [statusText, setStatusText] = useState('connecting…');
  const bufferRef = useRef<LogLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(400);

  const wrap = useLogPrefsStore((s) => s.wrap);
  const tsMode = useLogPrefsStore((s) => s.tsMode);
  const highlight = useLogPrefsStore((s) => s.highlight);
  const setWrap = useLogPrefsStore((s) => s.setWrap);
  const cycleTsMode = useLogPrefsStore((s) => s.cycleTsMode);
  const setHighlight = useLogPrefsStore((s) => s.setHighlight);
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const defaultTailLines = useUiPrefsStore((s) => s.defaultTailLines);
  const rowHeight = rowHeightFor(monoFontSize);
  const maximized = useDockStore((s) => s.maximized);
  const setMaximized = useDockStore((s) => s.setMaximized);

  const podColor = useMemo(() => {
    const map = new Map<string, string>();
    tab.pods.forEach((pod, i) => map.set(pod, POD_COLORS[i % POD_COLORS.length]!));
    return map;
  }, [tab.pods]);

  useEffect(() => {
    const modeParams = paramsForMode(timeMode);
    setLines([]);
    bufferRef.current = [];
    setFollow(modeParams.follow);
    setStatusText('connecting…');
    const ws = new WebSocket(
      wsUrl('/ws/logs', {
        ctx: tab.ctx,
        namespace: tab.namespace,
        pods: tab.pods.join(','),
        container: tab.container ?? '',
        previous: modeParams.previous ?? false,
        follow: modeParams.follow,
        tailLines: modeParams.tail ? (tab.tailLines ?? defaultTailLines) : tab.tailLines,
        sinceSeconds: modeParams.sinceSeconds ?? tab.sinceSeconds,
      }),
    );
    // Batch incoming lines into 120ms renders.
    const flush = window.setInterval(() => {
      if (!bufferRef.current.length) return;
      const fresh = bufferRef.current;
      bufferRef.current = [];
      setLines((prev) => {
        const next = [...prev, ...fresh];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }, 120);

    ws.onopen = () => setStatusText('streaming');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as LogServerMessage;
        if (msg.op === 'line') {
          bufferRef.current.push({ pod: msg.pod, container: msg.container, ts: msg.ts, line: msg.line, receivedAt: Date.now() });
        } else if (msg.op === 'pod-status' && msg.state === 'error') {
          bufferRef.current.push({ pod: msg.pod, container: msg.container, line: `⚠ ${msg.message ?? 'stream error'}`, receivedAt: Date.now() });
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => setStatusText('disconnected');
    return () => {
      window.clearInterval(flush);
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, timeMode]);

  // Status-bar stats may lag slightly: one O(n) pass over the deferred buffer keeps flushes cheap.
  const deferredLines = useDeferredValue(lines);
  const { levelCounts, recentRate } = useMemo(() => {
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
    const cutoff = Date.now() - 10_000;
    let recent = 0;
    for (const l of deferredLines) {
      const level = levelOf(l);
      if (level) counts[level] += 1;
      if (l.receivedAt >= cutoff) recent++;
    }
    return { levelCounts: counts, recentRate: recent / 10 };
  }, [deferredLines]);

  const toggleLevel = (level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const deferredFilter = useDeferredValue(filter);
  const visible = useMemo(() => {
    let out = lines;
    if (levelFilter.size) {
      out = out.filter((l) => {
        const level = levelOf(l);
        return level !== undefined && levelFilter.has(level);
      });
    }
    if (!deferredFilter) return out;
    try {
      const re = new RegExp(deferredFilter, 'i');
      return out.filter((l) => re.test(strippedOf(l)) || re.test(l.pod));
    } catch {
      const f = deferredFilter.toLowerCase();
      return out.filter((l) => strippedOf(l).toLowerCase().includes(f) || l.pod.toLowerCase().includes(f));
    }
  }, [lines, deferredFilter, levelFilter]);

  const matches = useMemo(() => {
    if (!find) return [];
    const q = find.toLowerCase();
    const idx: number[] = [];
    for (let i = 0; i < visible.length; i++) {
      if (strippedOf(visible[i]!).toLowerCase().includes(q)) idx.push(i);
    }
    return idx;
  }, [visible, find]);

  // Clamp the find cursor when the buffer rotates or the query changes.
  useEffect(() => {
    if (cursor >= matches.length) setCursor(Math.max(0, matches.length - 1));
  }, [matches.length, cursor]);

  const gotoMatch = useCallback(
    (idx: number) => {
      setFollow(false);
      const el = scrollRef.current;
      if (!el) return;
      if (wrap) {
        el.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'center' });
      } else {
        el.scrollTop = idx * rowHeight - el.clientHeight / 2;
      }
    },
    [wrap, rowHeight],
  );

  const findStep = useCallback(
    (dir: 1 | -1) => {
      if (!matches.length) return;
      const next = (cursor + dir + matches.length) % matches.length;
      setCursor(next);
      gotoMatch(matches[next]!);
    },
    [matches, cursor, gotoMatch],
  );

  // Auto-scroll on new lines while following.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visible.length, follow, wrap]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!wrap) {
      setScrollTop(el.scrollTop);
      setViewHeight(el.clientHeight);
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && follow) setFollow(false);
  }, [follow, wrap]);

  const download = () => {
    const text = visible.map((l) => `${l.ts ?? ''} [${l.pod}/${l.container}] ${strippedOf(l)}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${tab.title.replace(/\s+/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyVisible = async () => {
    const text = visible.map((l) => `${l.ts ?? ''} [${l.pod}/${l.container}] ${strippedOf(l)}`).join('\n');
    await copyToClipboard(text);
  };

  // Simple windowed rendering (nowrap) — only rows near the viewport mount.
  const start = wrap ? 0 : Math.max(0, Math.floor(scrollTop / rowHeight) - 20);
  const end = wrap ? visible.length : Math.min(visible.length, Math.ceil((scrollTop + viewHeight) / rowHeight) + 20);
  const currentMatch = matches.length ? matches[cursor] : undefined;
  const showPod = tab.pods.length > 1;

  return (
    <Box
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          findRef.current?.focus();
          findRef.current?.select();
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', flexShrink: 0, flexWrap: 'wrap' }}>
        <Select size="small" value={timeMode} onChange={(e) => setTimeMode(e.target.value as LogTimeMode)} sx={{ width: 124 }}>
          {TIME_OPTIONS.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
        <TextField placeholder="Filter (regex)…" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ width: 200 }} />
        <TextField
          placeholder="Find…"
          inputRef={findRef}
          value={find}
          onChange={(e) => {
            setFind(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              findStep(e.shiftKey ? -1 : 1);
            }
          }}
          sx={{ width: 170 }}
        />
        {find && (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 48, textAlign: 'center' }}>
              {matches.length ? `${cursor + 1} / ${matches.length}` : '0 / 0'}
            </Typography>
            <IconButton size="small" disabled={!matches.length} onClick={() => findStep(-1)}>
              <KeyboardArrowUpIcon fontSize="small" />
            </IconButton>
            <IconButton size="small" disabled={!matches.length} onClick={() => findStep(1)}>
              <KeyboardArrowDownIcon fontSize="small" />
            </IconButton>
          </>
        )}
        {LOG_LEVELS.filter((level) => levelCounts[level] > 0 || levelFilter.has(level)).map((level) => {
          const active = levelFilter.has(level);
          const { letter, color } = LEVEL_STYLE[level];
          return (
            <Tooltip key={level} title={`${active ? 'Stop filtering by' : 'Only show'} ${level} lines`}>
              <Chip
                label={`${letter} ${levelCounts[level]}`}
                size="small"
                variant={active ? 'filled' : 'outlined'}
                onClick={() => toggleLevel(level)}
                aria-label={`Filter ${level} logs`}
                sx={{
                  fontFamily: 'monospace',
                  fontWeight: 600,
                  color: active ? '#1a1a1e' : color,
                  bgcolor: active ? color : undefined,
                  borderColor: color,
                  '&:hover': { bgcolor: active ? color : undefined },
                }}
              />
            </Tooltip>
          );
        })}
        <Chip label={`${visible.length}/${lines.length} lines`} variant="outlined" />
        <Chip label={`${recentRate >= 10 ? recentRate.toFixed(0) : recentRate.toFixed(1)}/s`} variant="outlined" />
        <Typography variant="caption" color="text.secondary">
          {statusText}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={highlight ? 'Disable syntax highlighting' : 'Enable syntax highlighting (ANSI / JSON / logfmt)'}>
          <ToggleButton value="highlight" selected={highlight} size="small" onChange={() => setHighlight(!highlight)} sx={{ p: 0.5, fontSize: 12, lineHeight: 1, width: 28 }}>
            Aa
          </ToggleButton>
        </Tooltip>
        <Tooltip title={wrap ? 'Disable line wrap' : 'Wrap long lines'}>
          <ToggleButton value="wrap" selected={wrap} size="small" onChange={() => setWrap(!wrap)} sx={{ p: 0.5 }}>
            <WrapTextIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={`Timestamps: ${tsMode}`}>
          <ToggleButton value="ts" selected={tsMode !== 'off'} size="small" onChange={cycleTsMode} sx={{ p: 0.5 }}>
            <AccessTimeIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={follow ? 'Pause auto-scroll' : 'Resume auto-scroll'}>
          <ToggleButton value="follow" selected={follow} size="small" onChange={() => setFollow(!follow)} sx={{ p: 0.5 }}>
            {follow ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
          </ToggleButton>
        </Tooltip>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={() => setLines([])}>
            <DeleteSweepIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Download">
          <IconButton size="small" onClick={download}>
            <DownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Copy visible logs">
          <IconButton size="small" onClick={() => void copyVisible()}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={maximized ? 'Exit full screen' : 'Full screen'}>
          <IconButton size="small" onClick={() => setMaximized(!maximized)}>
            {maximized ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, p: 1, pt: 0.75 }}>
        <Box
          ref={scrollRef}
          onScroll={onScroll}
          sx={{
            height: '100%',
            overflow: 'auto',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: monoFontSize,
            bgcolor: '#151518',
            color: '#d4d4da',
            border: 1,
            borderColor: (theme) => (theme.palette.mode === 'dark' ? 'transparent' : theme.palette.divider),
            borderRadius: 1,
          }}
        >
          <Box sx={wrap ? undefined : { height: visible.length * rowHeight, position: 'relative' }}>
            {visible.slice(start, end).map((l, i) => {
              const idx = start + i;
              return (
                <LineRow
                  key={idx}
                  line={l}
                  idx={idx}
                  wrap={wrap}
                  showPod={showPod}
                  podColor={showPod ? (podColor.get(l.pod) ?? '#888') : undefined}
                  tsMode={tsMode}
                  highlight={highlight}
                  find={find}
                  isCurrent={idx === currentMatch}
                  rowHeight={rowHeight}
                />
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

interface LineRowProps {
  line: LogLine;
  idx: number;
  wrap: boolean;
  showPod: boolean;
  podColor?: string;
  tsMode: TsMode;
  highlight: boolean;
  find: string;
  isCurrent: boolean;
  rowHeight: number;
}

const LineRow = memo(function LineRow({ line, idx, wrap, showPod, podColor, tsMode, highlight, find, isCurrent, rowHeight }: LineRowProps) {
  const segs = highlight ? segsOf(line) : [{ text: strippedOf(line) }];
  const marked = find ? markSegs(segs, find) : segs;
  const level = levelOf(line);
  const tint = level ? LEVEL_ROW_TINT[level] : undefined;
  return (
    <Box
      data-idx={idx}
      sx={
        wrap
          ? { px: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', contentVisibility: 'auto', containIntrinsicSize: `auto ${rowHeight}px`, bgcolor: tint, '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }
          : { position: 'absolute', top: idx * rowHeight, left: 0, right: 0, height: rowHeight, px: 1, whiteSpace: 'pre', display: 'flex', gap: 1, bgcolor: tint, '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }
      }
    >
      {showPod && (
        <Box component="span" sx={{ color: podColor, flexShrink: 0, ...(wrap ? { mr: 1 } : {}) }}>
          {line.pod}
        </Box>
      )}
      {tsMode !== 'off' && (
        <Box component="span" sx={{ color: '#6b7089', flexShrink: 0, minWidth: '12ch', ...(wrap ? { mr: 1 } : {}) }}>
          {line.ts ? fmtTs(line.ts, tsMode) : ''}
        </Box>
      )}
      <Box component="span" sx={wrap ? undefined : { overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
      </Box>
    </Box>
  );
});
