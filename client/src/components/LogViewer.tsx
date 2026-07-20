import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
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
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import TuneIcon from '@mui/icons-material/Tune';
import { LOG_SOCKET_COMPLETE_CODE, LOG_SOCKET_NO_STREAMS_CODE, type LogServerMessage } from '@kubus/shared';
import { wsUrl } from '../api/http.js';
import { useDockStore, type LogsTab } from '../state/dock.js';
import { copyToClipboard } from '../clipboard.js';
import { useLogPrefsStore, type TsMode } from '../state/log-prefs.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { isTextEntryTarget } from '../text-entry.js';
import { detectLevel, LOG_LEVELS, markSegs, parseLine, stripAnsi, type LogLevel, type Seg } from './log-format.js';

interface LogLine {
  kind: 'line';
  pod: string;
  container: string;
  ts?: string;
  line: string;
  receivedAt: number;
}

interface LogMarker {
  kind: 'marker';
  label: string;
  tone: 'manual' | 'warning' | 'success';
  receivedAt: number;
}

type LogEntry = LogLine | LogMarker;
type LogConnectionState = 'connecting' | 'streaming' | 'reconnecting' | 'complete' | 'disconnected';

interface LogSource {
  pod: string;
  containers: string[];
}

interface LogBuffer {
  entries: LogEntry[];
  markerCount: number;
}

interface SourceResumeCursor {
  timestamp: string;
  frameCounts: Map<string, number>;
}

const POD_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];
const MAX_ENTRIES = 20_000;
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_STABLE_MS = 10_000;
/** Virtualized row height for the default 12px mono font; scales with it. */
function rowHeightFor(fontSize: number): number {
  return fontSize + 8;
}
type LogTimeMode = 'live' | '10m' | '1h' | '6h' | '24h' | '30d' | 'last20k' | 'terminated';

const TIME_OPTIONS: Array<{ value: LogTimeMode; label: string; params: { follow: boolean; tail?: boolean; tailLines?: number; sinceSeconds?: number; previous?: boolean } }> = [
  { value: 'live', label: 'Live tail', params: { follow: true, tail: true } },
  { value: '10m', label: '10m ago', params: { follow: false, sinceSeconds: 10 * 60 } },
  { value: '1h', label: '1h ago', params: { follow: false, sinceSeconds: 60 * 60 } },
  { value: '6h', label: '6h ago', params: { follow: false, sinceSeconds: 6 * 60 * 60 } },
  { value: '24h', label: '24h ago', params: { follow: false, sinceSeconds: 24 * 60 * 60 } },
  { value: '30d', label: '30d ago', params: { follow: false, sinceSeconds: 30 * 24 * 60 * 60 } },
  { value: 'last20k', label: 'Last 20k', params: { follow: false, tailLines: MAX_ENTRIES } },
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
  if (tab.sinceSeconds === 30 * 24 * 60 * 60) return '30d';
  if (tab.follow === false && tab.sinceSeconds === undefined && (tab.tailLines === undefined || tab.tailLines === MAX_ENTRIES)) return 'last20k';
  return 'live';
}

function paramsForMode(mode: LogTimeMode): (typeof TIME_OPTIONS)[number]['params'] {
  return TIME_OPTIONS.find((opt) => opt.value === mode)?.params ?? TIME_OPTIONS[0]!.params;
}

function appendEntries(state: LogBuffer, fresh: LogEntry[]): LogBuffer {
  if (!fresh.length) return state;
  const combined = [...state.entries, ...fresh];
  const overflow = Math.max(0, combined.length - MAX_ENTRIES);
  let markerCount = state.markerCount;
  for (const entry of fresh) {
    if (entry.kind === 'marker') markerCount++;
  }
  for (let index = 0; index < overflow; index++) {
    if (combined[index]?.kind === 'marker') markerCount--;
  }
  return {
    entries: overflow ? combined.slice(overflow) : combined,
    markerCount,
  };
}

function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
}

function workloadPreferenceKey(ctx: string, namespace: string, kind: NonNullable<LogsTab['target']>['kind'] | undefined, name: string | undefined): string | undefined {
  if (!kind || !name) return undefined;
  return [ctx, namespace, kind, name].map(encodeURIComponent).join('/');
}

function sourceKey(pod: string, container: string): string {
  return `${pod}/${container}`;
}

function consumeReplayFrame(
  replayCursors: Map<string, SourceResumeCursor>,
  source: string,
  timestamp: string,
  line: string,
): boolean {
  const cursor = replayCursors.get(source);
  if (!cursor) return false;
  if (cursor.timestamp !== timestamp) {
    replayCursors.delete(source);
    return false;
  }
  const remaining = cursor.frameCounts.get(line) ?? 0;
  if (!remaining) return false;
  if (remaining === 1) cursor.frameCounts.delete(line);
  else cursor.frameCounts.set(line, remaining - 1);
  if (!cursor.frameCounts.size) replayCursors.delete(source);
  return true;
}

function recordResumeFrame(
  cursors: Map<string, SourceResumeCursor>,
  source: string,
  timestamp: string,
  line: string,
): void {
  const cursor = cursors.get(source);
  if (cursor?.timestamp === timestamp) {
    cursor.frameCounts.set(line, (cursor.frameCounts.get(line) ?? 0) + 1);
    return;
  }
  cursors.set(source, { timestamp, frameCounts: new Map([[line, 1]]) });
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

interface LogSourceSelectorProps {
  sources: readonly LogSource[];
  containerNames: readonly string[];
  enabledPods: ReadonlySet<string>;
  enabledContainers: ReadonlySet<string>;
  onApply: (pods: ReadonlySet<string>, containers: ReadonlySet<string>) => void;
}

const LogSourceSelector = memo(function LogSourceSelector({
  sources,
  containerNames,
  enabledPods,
  enabledContainers,
  onApply,
}: LogSourceSelectorProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draftPods, setDraftPods] = useState<ReadonlySet<string>>(() => new Set(enabledPods));
  const [draftContainers, setDraftContainers] = useState<ReadonlySet<string>>(() => new Set(enabledContainers));
  const podCountByContainer = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) {
      for (const container of source.containers) {
        counts.set(container, (counts.get(container) ?? 0) + 1);
      }
    }
    return counts;
  }, [sources]);

  const openSelector = (target: HTMLElement) => {
    setDraftPods(new Set(enabledPods));
    setDraftContainers(new Set(enabledContainers));
    setAnchor(target);
  };

  const togglePod = (pod: string) => {
    setDraftPods((current) => {
      if (current.has(pod) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(pod)) next.delete(pod);
      else next.add(pod);
      return next;
    });
  };

  const toggleContainer = (container: string) => {
    setDraftContainers((current) => {
      if (current.has(container) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(container)) next.delete(container);
      else next.add(container);
      return next;
    });
  };

  const selectionChanged = !setsEqual(draftPods, enabledPods) || !setsEqual(draftContainers, enabledContainers);

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<TuneIcon fontSize="small" />}
        onClick={(event) => openSelector(event.currentTarget)}
        aria-label="Select log pods and containers"
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : undefined}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {enabledPods.size}/{sources.length} pods · {containerNames.length ? `${enabledContainers.size}/${containerNames.length} containers` : 'all containers'}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { minWidth: 300, maxHeight: 480 } } }}>
        {anchor ? (
          <>
            <ListSubheader disableSticky>Pods</ListSubheader>
            {sources.map((source) => {
              const checked = draftPods.has(source.pod);
              return (
                <MenuItem key={source.pod} dense disabled={checked && draftPods.size === 1} onClick={() => togglePod(source.pod)}>
                  <Checkbox size="small" checked={checked} />
                  <ListItemText primary={source.pod} secondary={source.containers.join(', ') || 'Containers discovered by server'} />
                </MenuItem>
              );
            })}
            {containerNames.length ? <Divider /> : null}
            {containerNames.length ? <ListSubheader disableSticky>Containers</ListSubheader> : null}
            {containerNames.map((container) => {
              const checked = draftContainers.has(container);
              const podCount = podCountByContainer.get(container) ?? 0;
              return (
                <MenuItem key={container} dense disabled={checked && draftContainers.size === 1} onClick={() => toggleContainer(container)}>
                  <Checkbox size="small" checked={checked} />
                  <ListItemText primary={container} secondary={`Available in ${podCount} ${podCount === 1 ? 'pod' : 'pods'}`} />
                </MenuItem>
              );
            })}
            <Divider />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, px: 1.5, py: 1 }}>
              <Button size="small" onClick={() => setAnchor(null)}>
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                disabled={!selectionChanged}
                onClick={() => {
                  onApply(draftPods, draftContainers);
                  setAnchor(null);
                }}
              >
                Apply
              </Button>
            </Box>
          </>
        ) : null}
      </Menu>
    </>
  );
});

export function LogViewer({ tab }: { tab: LogsTab }) {
  const initialMode = initialTimeMode(tab);
  const sources = useMemo(
    () =>
      tab.sources?.length
        ? tab.sources
        : tab.pods.map((pod) => ({
            pod,
            containers: tab.container ? [tab.container] : [],
          })),
    [tab.container, tab.pods, tab.sources],
  );
  const allContainerNames = useMemo(() => {
    const seen = new Set<string>();
    for (const source of sources) {
      for (const container of source.containers) seen.add(container);
    }
    return [...seen];
  }, [sources]);
  const preferenceKey = useMemo(
    () => workloadPreferenceKey(tab.ctx, tab.namespace, tab.target?.kind, tab.target?.name),
    [tab.ctx, tab.namespace, tab.target?.kind, tab.target?.name],
  );

  const [logBuffer, setLogBuffer] = useState<LogBuffer>({ entries: [], markerCount: 0 });
  const entries = logBuffer.entries;
  const totalLineCount = entries.length - logBuffer.markerCount;
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<ReadonlySet<LogLevel>>(new Set());
  const [find, setFind] = useState('');
  const [cursor, setCursor] = useState(0);
  const [follow, setFollow] = useState(() => paramsForMode(initialMode).follow);
  const [timeMode, setTimeMode] = useState<LogTimeMode>(initialMode);
  const [connectionState, setConnectionState] = useState<LogConnectionState>('connecting');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [enabledPods, setEnabledPods] = useState<ReadonlySet<string>>(() => new Set(tab.pods));
  const [enabledContainers, setEnabledContainers] = useState<ReadonlySet<string>>(() => {
    if (tab.container) return new Set([tab.container]);
    const remembered = preferenceKey ? useLogPrefsStore.getState().enabledContainersByWorkload[preferenceKey] : undefined;
    const available = remembered?.filter((container) => allContainerNames.includes(container)) ?? [];
    return new Set(available.length ? available : allContainerNames);
  });
  const bufferRef = useRef<LogLine[]>([]);
  const resumeCursorBySourceRef = useRef(new Map<string, SourceResumeCursor>());
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
  const rememberEnabledContainers = useLogPrefsStore((s) => s.rememberEnabledContainers);
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

  const enabledPodsParam = useMemo(() => tab.pods.filter((pod) => enabledPods.has(pod)).join(','), [enabledPods, tab.pods]);
  const enabledContainersParam = useMemo(
    () => allContainerNames.filter((container) => enabledContainers.has(container)).join(','),
    [allContainerNames, enabledContainers],
  );
  const selectedSourceCount = useMemo(() => {
    if (!allContainerNames.length) return Math.max(1, enabledPods.size);
    let count = 0;
    for (const source of sources) {
      if (!enabledPods.has(source.pod)) continue;
      for (const container of source.containers) {
        if (enabledContainers.has(container)) count++;
      }
    }
    return Math.max(1, count);
  }, [allContainerNames.length, enabledContainers, enabledPods, sources]);

  const flushBuffered = useCallback(() => {
    if (!bufferRef.current.length) return;
    const fresh = bufferRef.current;
    bufferRef.current = [];
    setLogBuffer((current) => appendEntries(current, fresh));
  }, []);

  const appendMarker = useCallback((label: string, tone: LogMarker['tone']) => {
    const fresh = bufferRef.current;
    bufferRef.current = [];
    const marker: LogMarker = { kind: 'marker', label, tone, receivedAt: Date.now() };
    setLogBuffer((current) => appendEntries(current, [...fresh, marker]));
  }, []);

  // Batch incoming lines into 120ms renders independently of socket retries.
  useEffect(() => {
    const flush = window.setInterval(flushBuffered, 120);
    return () => window.clearInterval(flush);
  }, [flushBuffered]);

  useEffect(() => {
    const modeParams = paramsForMode(timeMode);
    let disposed = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let stableTimer: number | undefined;
    let failures = 0;

    const connect = () => {
      if (disposed) return;
      const resumeAt = Object.fromEntries(
        [...resumeCursorBySourceRef.current].map(([key, cursor]) => [key, cursor.timestamp]),
      );
      const replayCursors = new Map(
        [...resumeCursorBySourceRef.current].map(([key, cursor]) => [
          key,
          { timestamp: cursor.timestamp, frameCounts: new Map(cursor.frameCounts) },
        ]),
      );
      const requestedSinceSeconds =
        modeParams.tailLines !== undefined ? undefined : (modeParams.sinceSeconds ?? tab.sinceSeconds);
      const combinedTailLines =
        modeParams.tailLines ?? (requestedSinceSeconds !== undefined ? MAX_ENTRIES : undefined);
      const requestedTailLines =
        combinedTailLines !== undefined
          ? Math.max(1, Math.floor(combinedTailLines / selectedSourceCount))
          : modeParams.tail
            ? (tab.tailLines ?? defaultTailLines)
            : undefined;
      socket = new WebSocket(wsUrl('/ws/logs', {
        ctx: tab.ctx,
        namespace: tab.namespace,
        pods: enabledPodsParam,
        containers: allContainerNames.length ? enabledContainersParam : undefined,
        previous: modeParams.previous ?? false,
        follow: modeParams.follow,
        tailLines: requestedTailLines,
        sinceSeconds: requestedSinceSeconds,
        resumeAt: Object.keys(resumeAt).length ? JSON.stringify(resumeAt) : undefined,
      }));
      let opened = false;

      socket.onopen = () => {
        opened = true;
        if (failures > 0) appendMarker(`Reconnected after ${failures} ${failures === 1 ? 'attempt' : 'attempts'}`, 'success');
        setConnectionState('streaming');
        window.clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => {
          failures = 0;
          setRetryAttempt(0);
        }, RECONNECT_STABLE_MS);
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as LogServerMessage;
          if (msg.op === 'line') {
            const key = sourceKey(msg.pod, msg.container);
            if (msg.ts) {
              if (consumeReplayFrame(replayCursors, key, msg.ts, msg.line)) return;
              recordResumeFrame(resumeCursorBySourceRef.current, key, msg.ts, msg.line);
            }
            bufferRef.current.push({ kind: 'line', pod: msg.pod, container: msg.container, ts: msg.ts, line: msg.line, receivedAt: Date.now() });
          } else if (msg.op === 'pod-status' && msg.state === 'error') {
            bufferRef.current.push({ kind: 'line', pod: msg.pod, container: msg.container, line: `⚠ ${msg.message ?? 'stream error'}`, receivedAt: Date.now() });
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        window.clearTimeout(stableTimer);
        if (event.code === LOG_SOCKET_COMPLETE_CODE) {
          setConnectionState('complete');
          setRetryAttempt(0);
          return;
        }
        if (event.code === LOG_SOCKET_NO_STREAMS_CODE) {
          setConnectionState('disconnected');
          setRetryAttempt(0);
          return;
        }
        if (opened) appendMarker('Connection interrupted', 'warning');
        if (failures >= MAX_RECONNECT_ATTEMPTS) {
          setConnectionState('disconnected');
          setRetryAttempt(MAX_RECONNECT_ATTEMPTS);
          return;
        }
        failures += 1;
        setRetryAttempt(failures);
        setConnectionState('reconnecting');
        retryTimer = window.setTimeout(connect, reconnectDelay(failures));
      };
    };

    setConnectionState('connecting');
    setRetryAttempt(0);
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(stableTimer);
      socket?.close(1000, 'log session changed');
    };
  }, [
    allContainerNames.length,
    appendMarker,
    defaultTailLines,
    enabledContainersParam,
    enabledPodsParam,
    reconnectToken,
    selectedSourceCount,
    tab.ctx,
    tab.namespace,
    tab.sinceSeconds,
    tab.tailLines,
    timeMode,
  ]);

  // Status-bar stats may lag slightly: one O(n) pass over the deferred buffer keeps flushes cheap.
  const deferredEntries = useDeferredValue(entries);
  const { levelCounts, recentRate } = useMemo(() => {
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
    const cutoff = Date.now() - 10_000;
    let recent = 0;
    for (const entry of deferredEntries) {
      if (entry.kind === 'marker') continue;
      const level = levelOf(entry);
      if (level) counts[level] += 1;
      if (entry.receivedAt >= cutoff) recent++;
    }
    return { levelCounts: counts, recentRate: recent / 10 };
  }, [deferredEntries]);

  const toggleLevel = (level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const deferredFilter = useDeferredValue(filter);
  const { visible, visibleLineCount } = useMemo(() => {
    if (!levelFilter.size && !deferredFilter) {
      return { visible: entries, visibleLineCount: totalLineCount };
    }

    let matchesText: (entry: LogLine) => boolean;
    try {
      const re = new RegExp(deferredFilter, 'i');
      matchesText = deferredFilter ? (entry) => re.test(strippedOf(entry)) || re.test(entry.pod) || re.test(entry.container) : () => true;
    } catch {
      const f = deferredFilter.toLowerCase();
      matchesText = (entry) => strippedOf(entry).toLowerCase().includes(f) || entry.pod.toLowerCase().includes(f) || entry.container.toLowerCase().includes(f);
    }

    const nextVisible: LogEntry[] = [];
    let nextLineCount = 0;
    for (const entry of entries) {
      if (entry.kind === 'marker') {
        nextVisible.push(entry);
        continue;
      }
      if (levelFilter.size) {
        const level = levelOf(entry);
        if (level === undefined || !levelFilter.has(level)) continue;
      }
      if (!matchesText(entry)) continue;
      nextVisible.push(entry);
      nextLineCount++;
    }
    return { visible: nextVisible, visibleLineCount: nextLineCount };
  }, [entries, deferredFilter, levelFilter, totalLineCount]);

  const matches = useMemo(() => {
    if (!find) return [];
    const q = find.toLowerCase();
    const idx: number[] = [];
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      if (entry.kind === 'line' && strippedOf(entry).toLowerCase().includes(q)) idx.push(i);
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

  const entryText = (entry: LogEntry): string =>
    entry.kind === 'marker'
      ? `--- ${entry.label} ---`
      : `${entry.ts ?? ''} [${entry.pod}/${entry.container}] ${strippedOf(entry)}`;

  const download = () => {
    const text = visible.map(entryText).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${tab.title.replace(/\s+/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyVisible = async () => {
    const text = visible.map(entryText).join('\n');
    await copyToClipboard(text);
  };

  const changeTimeMode = (next: LogTimeMode) => {
    bufferRef.current = [];
    resumeCursorBySourceRef.current.clear();
    setLogBuffer({ entries: [], markerCount: 0 });
    setFollow(paramsForMode(next).follow);
    setTimeMode(next);
  };

  const addVisualMarker = useCallback(() => {
    appendMarker(`Marker · ${new Date().toLocaleTimeString()}`, 'manual');
  }, [appendMarker]);

  const clearEntries = () => {
    bufferRef.current = [];
    setLogBuffer({ entries: [], markerCount: 0 });
  };

  const applySourceSelection = useCallback(
    (pods: ReadonlySet<string>, containers: ReadonlySet<string>) => {
      setEnabledPods(new Set(pods));
      setEnabledContainers(new Set(containers));
      if (preferenceKey) {
        rememberEnabledContainers(preferenceKey, allContainerNames.filter((name) => containers.has(name)));
      }
    },
    [allContainerNames, preferenceKey, rememberEnabledContainers],
  );

  // Simple windowed rendering (nowrap) — only rows near the viewport mount.
  const start = wrap ? 0 : Math.max(0, Math.floor(scrollTop / rowHeight) - 20);
  const end = wrap ? visible.length : Math.min(visible.length, Math.ceil((scrollTop + viewHeight) / rowHeight) + 20);
  const currentMatch = matches.length ? matches[cursor] : undefined;
  const showPod = tab.pods.length > 1;
  const showSource = showPod || allContainerNames.length > 1;
  const connectionTooltip =
    connectionState === 'reconnecting'
      ? `Reconnect attempt ${retryAttempt} of ${MAX_RECONNECT_ATTEMPTS}`
      : connectionState === 'disconnected'
        ? retryAttempt
          ? `Stopped after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
          : 'No log streams are available'
        : connectionState === 'complete'
          ? 'Log session complete'
        : connectionState;

  return (
    <Box
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          findRef.current?.focus();
          findRef.current?.select();
          return;
        }
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (
          e.key === ' ' &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !isTextEntryTarget(e.target) &&
          !target?.closest('button, [role="button"]')
        ) {
          e.preventDefault();
          addVisualMarker();
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', flexShrink: 0, flexWrap: 'wrap' }}>
        <Select size="small" value={timeMode} onChange={(e) => changeTimeMode(e.target.value as LogTimeMode)} sx={{ width: 124 }}>
          {TIME_OPTIONS.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
        <LogSourceSelector
          sources={sources}
          containerNames={allContainerNames}
          enabledPods={enabledPods}
          enabledContainers={enabledContainers}
          onApply={applySourceSelection}
        />
        <TextField
          placeholder="Filter (regex)…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (filter) setFilter('');
            else (e.target as HTMLElement).blur();
          }}
          sx={{ width: 200 }}
        />
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
              return;
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (find) {
                setFind('');
                setCursor(0);
              } else {
                (e.target as HTMLElement).blur();
              }
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
        <Chip label={`${visibleLineCount}/${totalLineCount} lines`} variant="outlined" />
        <Chip label={`${recentRate >= 10 ? recentRate.toFixed(0) : recentRate.toFixed(1)}/s`} variant="outlined" />
        <Tooltip title={connectionTooltip}>
          <Chip
            size="small"
            label={connectionState}
            color={connectionState === 'streaming' || connectionState === 'complete' ? 'success' : connectionState === 'reconnecting' ? 'warning' : connectionState === 'disconnected' ? 'error' : 'info'}
            variant="outlined"
            icon={
              connectionState === 'connecting' || connectionState === 'reconnecting' ? (
                <CircularProgress size={12} color="inherit" />
              ) : connectionState === 'streaming' ? (
                <FiberManualRecordIcon />
              ) : connectionState === 'complete' ? (
                <CheckCircleOutlinedIcon />
              ) : (
                <LinkOffIcon />
              )
            }
          />
        </Tooltip>
        {connectionState === 'disconnected' && (
          <Tooltip title="Reconnect now">
            <IconButton
              size="small"
              aria-label="Reconnect log stream"
              onClick={() => {
                setConnectionState('connecting');
                setReconnectToken((token) => token + 1);
              }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title={highlight ? 'Disable syntax highlighting' : 'Enable syntax highlighting (ANSI / JSON / logfmt)'}>
          <ToggleButton
            value="highlight"
            selected={highlight}
            size="small"
            aria-label={highlight ? 'Disable syntax highlighting' : 'Enable syntax highlighting'}
            onChange={() => setHighlight(!highlight)}
            sx={{ p: 0.5, fontSize: 12, lineHeight: 1, width: 28 }}
          >
            Aa
          </ToggleButton>
        </Tooltip>
        <Tooltip title={wrap ? 'Disable line wrap' : 'Wrap long lines'}>
          <ToggleButton value="wrap" selected={wrap} size="small" aria-label={wrap ? 'Disable line wrap' : 'Wrap long lines'} onChange={() => setWrap(!wrap)} sx={{ p: 0.5 }}>
            <WrapTextIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={`Timestamps: ${tsMode}`}>
          <ToggleButton value="ts" selected={tsMode !== 'off'} size="small" aria-label={`Timestamps: ${tsMode}`} onChange={cycleTsMode} sx={{ p: 0.5 }}>
            <AccessTimeIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={follow ? 'Pause auto-scroll' : 'Resume auto-scroll'}>
          <ToggleButton value="follow" selected={follow} size="small" aria-label={follow ? 'Pause auto-scroll' : 'Resume auto-scroll'} onChange={() => setFollow(!follow)} sx={{ p: 0.5 }}>
            {follow ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
          </ToggleButton>
        </Tooltip>
        <Tooltip title="Add visual marker (Space)">
          <IconButton size="small" aria-label="Add visual log marker" onClick={addVisualMarker}>
            <FlagOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={clearEntries}>
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
          component="section"
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Log output"
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
                  showSource={showSource}
                  podColor={l.kind === 'line' && showSource ? (podColor.get(l.pod) ?? '#888') : undefined}
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
  line: LogEntry;
  idx: number;
  wrap: boolean;
  showPod: boolean;
  showSource: boolean;
  podColor?: string;
  tsMode: TsMode;
  highlight: boolean;
  find: string;
  isCurrent: boolean;
  rowHeight: number;
}

const LineRow = memo(function LineRow({ line, idx, wrap, showPod, showSource, podColor, tsMode, highlight, find, isCurrent, rowHeight }: LineRowProps) {
  if (line.kind === 'marker') {
    const color = line.tone === 'warning' ? '#e0af68' : line.tone === 'success' ? '#9ece6a' : '#bb9af7';
    return (
      <Box
        data-idx={idx}
        sx={
          wrap
            ? { minHeight: rowHeight, px: 1, display: 'flex', alignItems: 'center', gap: 1, color, contentVisibility: 'auto', containIntrinsicSize: `auto ${rowHeight}px` }
            : { position: 'absolute', top: idx * rowHeight, left: 0, right: 0, height: rowHeight, px: 1, display: 'flex', alignItems: 'center', gap: 1, color }
        }
      >
        <Divider sx={{ flex: 1, borderColor: color, opacity: 0.55 }} />
        <FlagOutlinedIcon sx={{ fontSize: 14 }} />
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
  const tint = level ? LEVEL_ROW_TINT[level] : undefined;
  const sourceLabel = showPod ? [line.pod, line.container].filter(Boolean).join('/') : line.container;
  return (
    <Box
      data-idx={idx}
      sx={
        wrap
          ? { px: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', contentVisibility: 'auto', containIntrinsicSize: `auto ${rowHeight}px`, bgcolor: tint, '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }
          : { position: 'absolute', top: idx * rowHeight, left: 0, right: 0, height: rowHeight, px: 1, whiteSpace: 'pre', display: 'flex', gap: 1, bgcolor: tint, '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }
      }
    >
      {showSource && (
        <Box component="span" sx={{ color: podColor, flexShrink: 0, ...(wrap ? { mr: 1 } : {}) }}>
          {sourceLabel}
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
