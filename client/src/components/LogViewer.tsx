import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import FilterAltOffOutlinedIcon from '@mui/icons-material/FilterAltOffOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { LOG_SOCKET_COMPLETE_CODE, LOG_SOCKET_NO_STREAMS_CODE, type LogServerMessage } from '@kubus/shared';
import { wsUrl } from '../api/http.js';
import type { LogsTab } from '../state/dock.js';
import { copyToClipboard } from '../clipboard.js';
import { exportFilename, saveTextFile } from '../save-file.js';
import { useLogPrefsStore, type LogView, type TsMode } from '../state/log-prefs.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { isTextEntryTarget } from '../text-entry.js';
import { LOG_LEVELS, type LogLevel } from './log-format.js';
import {
  formatLogExport,
  isValidRegex,
  LOG_EXPORT_FORMATS,
  logLine,
  mergeByTime,
  rowAt,
  rowsHeight,
  rowTop,
  shortPodLabels,
  textMatcher,
  type HistogramLevel,
  type LogEntry,
  type LogExportFormat,
  type LogLine,
  type LogMarker,
  type LogMarkerTone,
  type TallRow,
} from './log-tools.js';
import { LogExportMenu } from './LogExportMenu.js';
import { LogHistogram } from './LogHistogram.js';
import { fieldsOf, fmtTs, levelOf, LineRow, localLogTime, LOG_ROW_CSS, MARKER_COLOR, strippedOf } from './LogLineRow.js';
import { LogSourceSelector, type LogSource } from './LogSourceSelector.js';
import { LogViewMenu } from './LogViewMenu.js';

type LogConnectionState = 'connecting' | 'streaming' | 'reconnecting' | 'complete' | 'disconnected';

interface LogBuffer {
  entries: LogEntry[];
  markerCount: number;
}

interface SourceResumeCursor {
  timestamp: string;
  frameCounts: Map<string, number>;
}

interface SourceStatus {
  state: 'waiting' | 'streaming' | 'ended' | 'error';
  message?: string;
}

const POD_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];
const MAX_ENTRIES = 20_000;
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_STABLE_MS = 10_000;
/** A scroll counts as the reader's own when it follows wheel, touch, key or scrollbar input this closely. */
const USER_SCROLL_WINDOW_MS = 800;
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

const LEVEL_STYLE: Record<LogLevel, { letter: string; color: string }> = {
  error: { letter: 'E', color: '#f7768e' },
  warn: { letter: 'W', color: '#e0af68' },
  info: { letter: 'I', color: '#7aa2f7' },
  debug: { letter: 'D', color: '#9aa0b5' },
  trace: { letter: 'T', color: '#6b7089' },
};

/** Toolbar chip accents. The log body is always dark, but the toolbar follows
 *  the app theme — the dark-tuned LEVEL_STYLE hues wash out on the light
 *  toolbar, so light mode uses darker equivalents. */
const LEVEL_CHIP_COLOR: Record<'light' | 'dark', Record<LogLevel, string>> = {
  dark: { error: '#f7768e', warn: '#e0af68', info: '#7aa2f7', debug: '#9aa0b5', trace: '#6b7089' },
  light: { error: '#b91c1c', warn: '#8f6209', info: '#1d4ed8', debug: '#52525b', trace: '#71717a' },
};

/** Histogram bars follow the chips; lines without a detected level stay neutral. */
const HISTOGRAM_COLORS: Record<'light' | 'dark', Record<HistogramLevel, string>> = {
  dark: { ...LEVEL_CHIP_COLOR.dark, none: '#4b5063' },
  light: { ...LEVEL_CHIP_COLOR.light, none: '#c5c8d1' },
};

/** The same markers as ticks on the theme-coloured histogram. */
const HISTOGRAM_MARKER_COLOR: Record<'light' | 'dark', Record<LogMarkerTone, string>> = {
  dark: MARKER_COLOR,
  light: { manual: '#7c3aed', warning: '#8f6209', success: '#15803d', joined: '#0f766e', left: '#52525b' },
};

const localLogDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** Clock time for histogram labels, with the day when it is not today. */
function fmtClock(ms: number, mode: TsMode): string {
  const d = new Date(ms);
  if (mode === 'utc') {
    const iso = d.toISOString();
    return iso.slice(0, 10) === new Date().toISOString().slice(0, 10) ? `${iso.slice(11, 19)}Z` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
  }
  return d.toDateString() === new Date().toDateString() ? localLogTime.format(d) : `${localLogDay.format(d)} ${localLogTime.format(d).slice(0, 5)}`;
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
  const combined = mergeByTime(state.entries, fresh);
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

function markerOf(label: string, tone: LogMarkerTone): LogMarker {
  return { kind: 'marker', label, tone, receivedAt: Date.now() };
}

export function LogViewer({ tab }: { tab: LogsTab }) {
  const initialMode = initialTimeMode(tab);
  const theme = useTheme();
  const mode = theme.palette.mode;
  // Workload tabs follow the workload's pods through rollouts; pods picked by hand stay a fixed set.
  const followTarget = tab.target && tab.target.kind !== 'Pod' ? tab.target : undefined;
  const following = followTarget ? `${followTarget.kind} ${followTarget.name}` : undefined;

  const [sources, setSources] = useState<LogSource[]>(() =>
    tab.sources?.length
      ? tab.sources.map((source) => ({ pod: source.pod, containers: source.containers }))
      : tab.pods.map((pod) => ({ pod, containers: tab.container ? [tab.container] : [] })),
  );
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
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
  const [exclude, setExclude] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [levelFilter, setLevelFilter] = useState<ReadonlySet<LogLevel>>(new Set());
  const [find, setFind] = useState('');
  const [cursor, setCursor] = useState(0);
  const [follow, setFollow] = useState(() => paramsForMode(initialMode).follow);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingMarkers, setPendingMarkers] = useState(0);
  const [timeMode, setTimeMode] = useState<LogTimeMode>(initialMode);
  const [connectionState, setConnectionState] = useState<LogConnectionState>('connecting');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [sourceStatus, setSourceStatus] = useState<Readonly<Record<string, SourceStatus>>>({});
  const [podsKnown, setPodsKnown] = useState(!followTarget);
  const [disabledPods, setDisabledPods] = useState<ReadonlySet<string>>(() => new Set());
  // undefined = every container, including ones a new pod template adds.
  const [containerChoice, setContainerChoice] = useState<ReadonlySet<string> | undefined>(() => {
    if (tab.container) return new Set([tab.container]);
    const remembered = preferenceKey ? useLogPrefsStore.getState().enabledContainersByWorkload[preferenceKey] : undefined;
    const available = remembered?.filter((container) => allContainerNames.includes(container)) ?? [];
    return available.length && available.length < allContainerNames.length ? new Set(available) : undefined;
  });
  const [expanded, setExpanded] = useState<ReadonlySet<LogLine>>(() => new Set());
  const [measured, setMeasured] = useState<ReadonlyMap<LogLine, number>>(() => new Map());
  const [flash, setFlash] = useState<LogEntry | undefined>();
  const bufferRef = useRef<LogEntry[]>([]);
  const pendingLinesRef = useRef(0);
  const pendingMarkersRef = useRef(0);
  const pausedRef = useRef(false);
  const resumeCursorBySourceRef = useRef(new Map<string, SourceResumeCursor>());
  const goneRef = useRef(new Set<string>());
  const userScrollRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(400);

  const wrap = useLogPrefsStore((s) => s.wrap);
  const tsMode = useLogPrefsStore((s) => s.tsMode);
  const highlight = useLogPrefsStore((s) => s.highlight);
  const view = useLogPrefsStore((s) => s.view);
  const setWrap = useLogPrefsStore((s) => s.setWrap);
  const setTsMode = useLogPrefsStore((s) => s.setTsMode);
  const setHighlight = useLogPrefsStore((s) => s.setHighlight);
  const setView = useLogPrefsStore((s) => s.setView);
  const rememberEnabledContainers = useLogPrefsStore((s) => s.rememberEnabledContainers);
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const defaultTailLines = useUiPrefsStore((s) => s.defaultTailLines);
  const rowHeight = rowHeightFor(monoFontSize);

  // Colours stick to a pod for the life of the tab, also after it leaves.
  const podColorsRef = useRef(new Map<string, string>());
  for (const source of sources) {
    if (!podColorsRef.current.has(source.pod)) podColorsRef.current.set(source.pod, POD_COLORS[podColorsRef.current.size % POD_COLORS.length]!);
  }
  const podColors = podColorsRef.current;
  const podLabels = useMemo(() => shortPodLabels(sources.map((source) => source.pod)), [sources]);

  const enabledContainers = useMemo(() => containerChoice ?? new Set(allContainerNames), [allContainerNames, containerChoice]);
  const enabledPods = useMemo(
    () => new Set(sources.filter((source) => !source.gone && !disabledPods.has(source.pod)).map((source) => source.pod)),
    [disabledPods, sources],
  );
  const podsParam = useMemo(() => (followTarget ? undefined : tab.pods.filter((pod) => !disabledPods.has(pod)).join(',')), [disabledPods, followTarget, tab.pods]);
  const excludeParam = useMemo(() => (followTarget ? [...disabledPods].sort().join(',') || undefined : undefined), [disabledPods, followTarget]);
  const containersParam = useMemo(() => (containerChoice ? [...containerChoice].sort().join(',') : undefined), [containerChoice]);
  const selectedSourceCountRef = useRef(1);
  selectedSourceCountRef.current = useMemo(() => {
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

  const pushEntry = useCallback((entry: LogEntry) => {
    const pending = bufferRef.current;
    pending.push(entry);
    if (entry.kind === 'line') pendingLinesRef.current++;
    else pendingMarkersRef.current++;
    // A long pause keeps only what the buffer could show anyway.
    if (pending.length > MAX_ENTRIES * 1.25) pending.splice(0, pending.length - MAX_ENTRIES);
  }, []);

  const flushBuffered = useCallback(() => {
    if (pausedRef.current) {
      const lines = pendingLinesRef.current;
      const markers = pendingMarkersRef.current;
      setPendingCount((current) => (current === lines ? current : lines));
      setPendingMarkers((current) => (current === markers ? current : markers));
      return;
    }
    if (!bufferRef.current.length) return;
    const fresh = bufferRef.current;
    bufferRef.current = [];
    pendingLinesRef.current = 0;
    pendingMarkersRef.current = 0;
    setLogBuffer((current) => appendEntries(current, fresh));
  }, []);

  const appendMarker = useCallback(
    (label: string, tone: LogMarkerTone) => {
      pushEntry(markerOf(label, tone));
      flushBuffered();
    },
    [flushBuffered, pushEntry],
  );

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
    setFollow(false);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    setPendingCount(0);
    setPendingMarkers(0);
    setFollow(true);
    flushBuffered();
  }, [flushBuffered]);

  // Batch incoming lines into 120ms renders independently of socket retries.
  useEffect(() => {
    const flush = window.setInterval(flushBuffered, 120);
    return () => window.clearInterval(flush);
  }, [flushBuffered]);

  const podJoined = useCallback(
    (pod: string, containers: string[]) => {
      goneRef.current.delete(pod);
      if (sourcesRef.current.some((source) => source.pod === pod && !source.gone)) return;
      pushEntry(markerOf(`${pod} joined`, 'joined'));
      setSources((current) => [...current.filter((source) => source.pod !== pod), { pod, containers }]);
    },
    [pushEntry],
  );

  const podLeft = useCallback(
    (pod: string, reason: 'terminated' | 'deleted') => {
      for (const key of resumeCursorBySourceRef.current.keys()) {
        if (key.startsWith(`${pod}/`)) resumeCursorBySourceRef.current.delete(key);
      }
      setSourceStatus((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${pod}/`)));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
      if (goneRef.current.has(pod)) return;
      goneRef.current.add(pod);
      pushEntry(markerOf(`${pod} ${reason}`, 'left'));
      setSources((current) =>
        followTarget ? current.filter((source) => source.pod !== pod) : current.map((source) => (source.pod === pod ? { ...source, gone: true } : source)),
      );
    },
    [followTarget, pushEntry],
  );

  const podsSnapshot = useCallback(
    (pods: Array<{ pod: string; containers: string[] }>) => {
      const names = new Set(pods.map((pod) => pod.pod));
      // Anything that changed while the socket was down (or since the tab opened).
      for (const source of sourcesRef.current) {
        if (!names.has(source.pod) && !goneRef.current.has(source.pod)) {
          goneRef.current.add(source.pod);
          pushEntry(markerOf(`${source.pod} terminated`, 'left'));
        }
      }
      const known = new Set(sourcesRef.current.map((source) => source.pod));
      for (const pod of pods) {
        goneRef.current.delete(pod.pod);
        if (!known.has(pod.pod)) pushEntry(markerOf(`${pod.pod} joined`, 'joined'));
      }
      setSources(pods.map((pod) => ({ pod: pod.pod, containers: pod.containers })));
      setPodsKnown(true);
    },
    [pushEntry],
  );

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
          ? Math.max(1, Math.floor(combinedTailLines / selectedSourceCountRef.current))
          : modeParams.tail
            ? (tab.tailLines ?? defaultTailLines)
            : undefined;
      setSourceStatus({});
      socket = new WebSocket(wsUrl('/ws/logs', {
        ctx: tab.ctx,
        namespace: tab.namespace,
        pods: podsParam,
        target: followTarget?.kind,
        targetName: followTarget?.name,
        exclude: excludeParam,
        containers: containersParam,
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
        let msg: LogServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as LogServerMessage;
        } catch {
          return; // ignore malformed frames
        }
        switch (msg.op) {
          case 'line': {
            const key = sourceKey(msg.pod, msg.container);
            if (msg.ts) {
              if (consumeReplayFrame(replayCursors, key, msg.ts, msg.line)) return;
              recordResumeFrame(resumeCursorBySourceRef.current, key, msg.ts, msg.line);
            }
            pushEntry(logLine(msg.pod, msg.container, msg.line, msg.ts));
            return;
          }
          case 'pod-status': {
            if (msg.state === 'error') pushEntry(logLine(msg.pod, msg.container, `⚠ ${msg.message ?? 'stream error'}`));
            if (!msg.pod || !['waiting', 'streaming', 'ended', 'error'].includes(msg.state)) return;
            const key = sourceKey(msg.pod, msg.container);
            setSourceStatus((current) =>
              current[key]?.state === msg.state && current[key]?.message === msg.message ? current : { ...current, [key]: { state: msg.state, message: msg.message } },
            );
            return;
          }
          case 'pods':
            podsSnapshot(msg.pods);
            return;
          case 'pod-joined':
            podJoined(msg.pod, msg.containers);
            return;
          case 'pod-left':
            podLeft(msg.pod, msg.reason);
            return;
          default:
            return;
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
    appendMarker,
    containersParam,
    defaultTailLines,
    excludeParam,
    followTarget?.kind,
    followTarget?.name,
    podJoined,
    podLeft,
    podsParam,
    podsSnapshot,
    pushEntry,
    reconnectToken,
    tab.ctx,
    tab.namespace,
    tab.sinceSeconds,
    tab.tailLines,
    timeMode,
  ]);

  // Status-bar stats may lag slightly: one O(n) pass over the deferred buffer keeps flushes cheap.
  const deferredEntries = useDeferredValue(entries);
  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
    for (const entry of deferredEntries) {
      if (entry.kind === 'marker') continue;
      const level = levelOf(entry);
      if (level) counts[level] += 1;
    }
    return counts;
  }, [deferredEntries]);
  // The rate counts arrivals, including lines held back by a pause.
  const recentRate = useMemo(() => {
    const cutoff = Date.now() - 10_000;
    let recent = 0;
    for (const list of [deferredEntries, pendingCount ? bufferRef.current : []]) {
      for (const entry of list) {
        if (entry.kind === 'line' && entry.receivedAt >= cutoff) recent++;
      }
    }
    return recent / 10;
  }, [deferredEntries, pendingCount]);

  const toggleLevel = (level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const deferredFilter = useDeferredValue(filter);
  const deferredExclude = useDeferredValue(exclude);
  const { visible, visibleLineCount } = useMemo(() => {
    if (!levelFilter.size && !deferredFilter && !deferredExclude) {
      return { visible: entries, visibleLineCount: totalLineCount };
    }
    const includes = textMatcher(deferredFilter, matchCase);
    const excludes = textMatcher(deferredExclude, matchCase);

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
      if (includes) {
        const text = strippedOf(entry);
        if (!includes(text) && !includes(entry.pod) && !includes(entry.container)) continue;
      }
      if (excludes?.(strippedOf(entry))) continue;
      nextVisible.push(entry);
      nextLineCount++;
    }
    return { visible: nextVisible, visibleLineCount: nextLineCount };
  }, [entries, deferredFilter, deferredExclude, levelFilter, matchCase, totalLineCount]);
  const deferredVisible = useDeferredValue(visible);

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

  // Expanded field tables make their rows taller; only the virtualized (nowrap) layout needs the offsets.
  const tallRows = useMemo<TallRow[]>(() => {
    if (!expanded.size || wrap) return [];
    const rows: TallRow[] = [];
    visible.forEach((entry, idx) => {
      if (entry.kind !== 'line' || !expanded.has(entry)) return;
      rows.push({ idx, extra: measured.get(entry) ?? ((fieldsOf(entry)?.fields.length ?? 0) + 1) * (rowHeight + 4) + 12 });
    });
    return rows;
  }, [expanded, measured, rowHeight, visible, wrap]);

  const live = connectionState === 'connecting' || connectionState === 'streaming' || connectionState === 'reconnecting';

  const scrollToIndex = useCallback(
    (idx: number, block: 'center' | 'start' = 'center') => {
      const el = scrollRef.current;
      if (!el) return;
      if (wrap) {
        el.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block });
      } else {
        el.scrollTop = rowTop(idx, rowHeight, tallRows) - (block === 'center' ? el.clientHeight / 2 : rowHeight * 2);
      }
    },
    [rowHeight, tallRows, wrap],
  );

  // Hold the view still while the reader looks at a match or a moment.
  const holdView = useCallback(() => {
    if (live) pause();
    else setFollow(false);
  }, [live, pause]);

  const findStep = useCallback(
    (dir: 1 | -1) => {
      if (!matches.length) return;
      const next = (cursor + dir + matches.length) % matches.length;
      setCursor(next);
      holdView();
      scrollToIndex(matches[next]!);
    },
    [cursor, holdView, matches, scrollToIndex],
  );

  const jumpToEntry = useCallback(
    (idx: number) => {
      holdView();
      setFlash(visible[idx]);
      scrollToIndex(idx, 'start');
    },
    [holdView, scrollToIndex, visible],
  );

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // Auto-scroll on new lines while following.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visible.length, follow, wrap]);

  const markUserScroll = useCallback(() => {
    userScrollRef.current = Date.now();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!wrap) {
      setScrollTop(el.scrollTop);
      setViewHeight(el.clientHeight);
    }
    if (Date.now() - userScrollRef.current > USER_SCROLL_WINDOW_MS) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom) {
      // Reading back through a live tail freezes the view until you return.
      if (follow) setFollow(false);
      if (timeMode === 'live' && live && !pausedRef.current) pause();
    } else if (pausedRef.current || !follow) {
      resume();
    }
  }, [follow, live, pause, resume, timeMode, wrap]);

  const exportOptions = useMemo(
    () => ({
      showSource: sources.length > 1 || !!followTarget || allContainerNames.length > 1,
      showPod: sources.length > 1 || !!followTarget,
      formatTs: tsMode === 'off' ? undefined : (ts: string) => fmtTs(ts, tsMode),
      levelOf,
    }),
    [allContainerNames.length, followTarget, sources.length, tsMode],
  );

  const exportPreview = useCallback(
    (format: LogExportFormat) => {
      const sample = visible.findLast((entry) => entry.kind === 'line');
      return sample ? formatLogExport([sample], format, exportOptions) : undefined;
    },
    [exportOptions, visible],
  );

  const download = (format: LogExportFormat) => {
    const spec = LOG_EXPORT_FORMATS.find((candidate) => candidate.value === format)!;
    saveTextFile(exportFilename(tab.title, spec.ext), formatLogExport(visible, format, exportOptions), spec.mime);
  };

  const copyVisible = async (format: LogExportFormat) => {
    const spec = LOG_EXPORT_FORMATS.find((candidate) => candidate.value === format)!;
    const ok = await copyToClipboard(formatLogExport(visible, format, exportOptions));
    if (ok) showToast('success', `Copied ${visibleLineCount.toLocaleString()} ${visibleLineCount === 1 ? 'line' : 'lines'} (${spec.label.toLowerCase()})`);
    else showToast('error', 'Could not copy the logs to the clipboard');
  };

  const resetBuffer = () => {
    bufferRef.current = [];
    pendingLinesRef.current = 0;
    pendingMarkersRef.current = 0;
    setPendingCount(0);
    setPendingMarkers(0);
    setLogBuffer({ entries: [], markerCount: 0 });
    setExpanded(new Set());
    setMeasured(new Map());
  };

  const changeTimeMode = (next: LogTimeMode) => {
    resetBuffer();
    resumeCursorBySourceRef.current.clear();
    pausedRef.current = false;
    setPaused(false);
    setFollow(paramsForMode(next).follow);
    setTimeMode(next);
  };

  const addVisualMarker = useCallback(() => {
    appendMarker(`Marker · ${new Date().toLocaleTimeString()}`, 'manual');
  }, [appendMarker]);

  const applySourceSelection = useCallback(
    (pods: ReadonlySet<string>, containers: ReadonlySet<string>) => {
      setDisabledPods(new Set(sourcesRef.current.filter((source) => !pods.has(source.pod)).map((source) => source.pod)));
      setContainerChoice(allContainerNames.every((name) => containers.has(name)) && !tab.container ? undefined : new Set(containers));
      if (preferenceKey) {
        rememberEnabledContainers(preferenceKey, allContainerNames.filter((name) => containers.has(name)));
      }
    },
    [allContainerNames, preferenceKey, rememberEnabledContainers, tab.container],
  );

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const holdViewRef = useRef(holdView);
  holdViewRef.current = holdView;
  const revealRef = useRef<LogLine | undefined>(undefined);
  const toggleExpanded = useCallback((line: LogLine) => {
    const next = new Set(expandedRef.current);
    if (next.has(line)) {
      next.delete(line);
    } else {
      next.add(line);
      // Reading a line's fields: keep it where it is and bring the table into view.
      revealRef.current = line;
      holdViewRef.current();
    }
    setExpanded(next);
  }, []);
  // One handler for every row: clicking a JSON or logfmt line (not selecting text in it) toggles its fields.
  const onBodyClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest('[data-expandable]')?.closest('[data-idx]');
    if (!(row instanceof HTMLElement)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString()) return;
    const entry = visible[Number(row.dataset.idx)];
    if (entry?.kind === 'line') toggleExpanded(entry);
  };

  const revealed = useCallback(() => {
    revealRef.current = undefined;
  }, []);

  const measureRow = useCallback((line: LogLine, extra: number) => {
    setMeasured((current) => {
      const previous = current.get(line);
      if (previous !== undefined && Math.abs(previous - extra) < 1) return current;
      const next = new Map(current);
      next.set(line, extra);
      return next;
    });
  }, []);

  const podNotes = useMemo(() => {
    const notes = new Map<string, string>();
    for (const source of sources) {
      if (source.gone) notes.set(source.pod, 'terminated');
    }
    for (const [key, status] of Object.entries(sourceStatus)) {
      if (status.state !== 'waiting') continue;
      const pod = key.slice(0, key.indexOf('/'));
      if (!notes.has(pod)) notes.set(pod, `waiting: ${status.message ?? 'not started'}`);
    }
    return notes;
  }, [sourceStatus, sources]);

  const waitingSources = useMemo(
    () => Object.entries(sourceStatus).filter(([, status]) => status.state === 'waiting').map(([key, status]) => `${key}: ${status.message ?? 'not started'}`),
    [sourceStatus],
  );
  const anyStreaming = useMemo(() => Object.values(sourceStatus).some((status) => status.state === 'streaming'), [sourceStatus]);
  const noPods = !!followTarget && podsKnown && sources.length === 0;
  const displayState: LogConnectionState | 'waiting' =
    connectionState === 'streaming' && !anyStreaming && (waitingSources.length > 0 || noPods) ? 'waiting' : connectionState;

  const formatClock = useCallback((ms: number) => fmtClock(ms, tsMode), [tsMode]);

  // Simple windowed rendering (nowrap) — only rows near the viewport mount.
  const start = wrap ? 0 : Math.max(0, rowAt(scrollTop, rowHeight, tallRows) - 20);
  const end = wrap ? visible.length : Math.min(visible.length, rowAt(scrollTop + viewHeight, rowHeight, tallRows) + 20);
  const currentMatch = matches.length ? matches[cursor] : undefined;
  const showPod = sources.length > 1 || !!followTarget;
  const showSource = showPod || allContainerNames.length > 1;
  // The Message / Raw switch only matters when the tab has JSON or logfmt lines.
  const hasStructured = useMemo(() => {
    for (let index = deferredVisible.length - 1, seen = 0; index >= 0 && seen < 400; index -= 1) {
      const entry = deferredVisible[index]!;
      if (entry.kind !== 'line') continue;
      seen += 1;
      if (fieldsOf(entry)) return true;
    }
    return false;
  }, [deferredVisible]);
  const connectionTooltip =
    displayState === 'waiting'
      ? noPods
        ? `No pods of ${following} right now; new pods join as they start`
        : `Waiting for containers to start: ${waitingSources.join(', ')}`
      : displayState === 'reconnecting'
        ? `Reconnect attempt ${retryAttempt} of ${MAX_RECONNECT_ATTEMPTS}`
        : displayState === 'disconnected'
          ? retryAttempt
            ? `Stopped after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
            : 'No log streams are available'
          : displayState === 'complete'
            ? 'Log session complete'
            : following && displayState === 'streaming'
              ? `Streaming · following ${following}`
              : displayState;
  const filterInvalid = !!filter && !isValidRegex(filter);
  const excludeInvalid = !!exclude && !isValidRegex(exclude);
  const clearOnEscape = (value: string, setValue: (next: string) => void) => (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (value) setValue('');
    else (e.target as HTMLElement).blur();
  };

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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, pt: 0.5, pb: 0.25, flexShrink: 0, flexWrap: 'wrap' }}>
        <Select size="small" value={timeMode} onChange={(e) => changeTimeMode(e.target.value as LogTimeMode)} sx={{ width: 124 }} aria-label="Time range">
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
          following={following}
          podNotes={podNotes}
          podColors={showPod ? podColors : undefined}
          podLabels={podLabels}
          onApply={applySourceSelection}
        />
        <TextField
          placeholder="Filter (regex)…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={clearOnEscape(filter, setFilter)}
          sx={{ width: 180 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Show only lines matching' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Tooltip title={filterInvalid ? 'Not a valid regex: matching as plain text' : 'Show only matching lines'}>
                    <FilterAltOutlinedIcon sx={{ fontSize: 16, color: filterInvalid ? 'warning.main' : 'text.secondary' }} />
                  </Tooltip>
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title={matchCase ? 'Match case: on (filter and exclude)' : 'Match case: off (filter and exclude)'}>
                    <ToggleButton
                      value="match-case"
                      selected={matchCase}
                      size="small"
                      aria-label="Match case"
                      onChange={() => setMatchCase(!matchCase)}
                      sx={{ p: 0, px: 0.5, border: 0, fontSize: 11, fontWeight: 700, lineHeight: '18px', minWidth: 24 }}
                    >
                      Aa
                    </ToggleButton>
                  </Tooltip>
                </InputAdornment>
              ),
            },
          }}
        />
        <TextField
          placeholder="Exclude (regex)…"
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          onKeyDown={clearOnEscape(exclude, setExclude)}
          sx={{ width: 160 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Hide lines matching' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Tooltip title={excludeInvalid ? 'Not a valid regex: matching as plain text' : 'Hide matching lines, for example health checks'}>
                    <FilterAltOffOutlinedIcon sx={{ fontSize: 16, color: excludeInvalid ? 'warning.main' : 'text.secondary' }} />
                  </Tooltip>
                </InputAdornment>
              ),
            },
          }}
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
          sx={{ width: 190 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Find in logs' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: find ? (
                <InputAdornment position="end" sx={{ gap: 0.25 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    {matches.length ? `${cursor + 1} / ${matches.length}` : '0 / 0'}
                  </Typography>
                  <IconButton size="small" aria-label="Previous match" disabled={!matches.length} onClick={() => findStep(-1)} sx={{ p: 0.25 }}>
                    <KeyboardArrowUpIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" aria-label="Next match" disabled={!matches.length} onClick={() => findStep(1)} sx={{ p: 0.25 }}>
                    <KeyboardArrowDownIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            },
          }}
        />
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {hasStructured && (
            <ToggleButtonGroup
              exclusive
              size="small"
              value={view}
              onChange={(_event, next: LogView | null) => next && setView(next)}
              aria-label="Structured line display"
              sx={{ mr: 0.5, '& .MuiToggleButton-root': { py: 0.25, px: 1, fontSize: 12.5 } }}
            >
              <Tooltip describeChild title="JSON and logfmt lines: level and message first, other fields dimmed">
                <ToggleButton value="message">Message</ToggleButton>
              </Tooltip>
              <Tooltip describeChild title="Lines exactly as the containers wrote them">
                <ToggleButton value="raw">Raw</ToggleButton>
              </Tooltip>
            </ToggleButtonGroup>
          )}
          <LogViewMenu
            highlight={highlight}
            wrap={wrap}
            tsMode={tsMode}
            onHighlightChange={setHighlight}
            onWrapChange={setWrap}
            onTsModeChange={setTsMode}
            onAddMarker={addVisualMarker}
            onClear={resetBuffer}
          />
          <Tooltip title={paused ? `Resume${pendingCount ? ` (${pendingCount.toLocaleString()} new lines)` : ''}` : 'Pause: freeze the view, keep collecting'}>
            <ToggleButton
              value="pause"
              selected={paused}
              size="small"
              aria-label={paused ? 'Resume log view' : 'Pause log view'}
              onChange={() => (paused ? resume() : pause())}
              sx={{ p: 0.5 }}
            >
              {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
            </ToggleButton>
          </Tooltip>
          <LogExportMenu verb="Copy" icon={<ContentCopyIcon fontSize="small" />} lineCount={visibleLineCount} preview={exportPreview} onExport={(format) => void copyVisible(format)} />
          <LogExportMenu verb="Download" icon={<DownloadIcon fontSize="small" />} lineCount={visibleLineCount} preview={exportPreview} onExport={download} />
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, pt: 0.25, pb: 0.5, borderBottom: 1, borderColor: 'divider', flexShrink: 0, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {LOG_LEVELS.filter((level) => levelCounts[level] > 0 || levelFilter.has(level)).map((level) => {
            const active = levelFilter.has(level);
            const { letter } = LEVEL_STYLE[level];
            return (
              <Tooltip key={level} title={`${active ? 'Stop filtering by' : 'Only show'} ${level} lines`}>
                <Chip
                  label={`${letter} ${levelCounts[level].toLocaleString()}`}
                  size="small"
                  variant={active ? 'filled' : 'outlined'}
                  onClick={() => toggleLevel(level)}
                  aria-label={`Filter ${level} logs`}
                  aria-pressed={active}
                  sx={(chipTheme) => {
                    const color = LEVEL_CHIP_COLOR[chipTheme.palette.mode][level];
                    return {
                      fontFamily: 'monospace',
                      fontWeight: 600,
                      color: active ? (chipTheme.palette.mode === 'dark' ? '#1a1a1e' : '#ffffff') : color,
                      bgcolor: active ? color : undefined,
                      borderColor: color,
                      '&:hover': { bgcolor: active ? color : undefined },
                    };
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
        <LogHistogram
          entries={deferredVisible}
          levelOf={levelOf}
          colors={HISTOGRAM_COLORS[mode]}
          markerColors={HISTOGRAM_MARKER_COLOR[mode]}
          formatTime={formatClock}
          onJump={jumpToEntry}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Chip size="small" label={`${visibleLineCount.toLocaleString()}/${totalLineCount.toLocaleString()} lines`} variant="outlined" />
          <Chip size="small" label={`${recentRate >= 10 ? recentRate.toFixed(0) : recentRate.toFixed(1)}/s`} variant="outlined" />
          <Tooltip title={connectionTooltip}>
            <Chip
              size="small"
              label={displayState}
              color={
                displayState === 'streaming' || displayState === 'complete'
                  ? 'success'
                  : displayState === 'reconnecting'
                    ? 'warning'
                    : displayState === 'disconnected'
                      ? 'error'
                      : 'info'
              }
              variant="outlined"
              icon={
                displayState === 'connecting' || displayState === 'reconnecting' ? (
                  <CircularProgress size={12} color="inherit" />
                ) : displayState === 'waiting' ? (
                  <HourglassEmptyIcon />
                ) : displayState === 'streaming' ? (
                  <FiberManualRecordIcon />
                ) : displayState === 'complete' ? (
                  <CheckCircleOutlinedIcon />
                ) : (
                  <LinkOffIcon />
                )
              }
            />
          </Tooltip>
          {displayState === 'streaming' && waitingSources.length > 0 ? (
            <Tooltip title={<Box sx={{ whiteSpace: 'pre-line' }}>{`Waiting to start:\n${waitingSources.join('\n')}`}</Box>}>
              <Chip size="small" color="info" variant="outlined" icon={<HourglassEmptyIcon />} label={`${waitingSources.length} waiting`} />
            </Tooltip>
          ) : null}
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
        </Box>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, p: 1, pt: 0.75, position: 'relative' }}>
        <Box
          component="section"
          ref={scrollRef}
          onScroll={onScroll}
          onClick={onBodyClick}
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onPointerDown={(e) => {
            // Only the scrollbar: clicks on rows (expanding fields) scroll programmatically.
            if (e.target === e.currentTarget) markUserScroll();
          }}
          onKeyDown={(e) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) markUserScroll();
          }}
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
            borderColor: (borderTheme) => (borderTheme.palette.mode === 'dark' ? 'transparent' : borderTheme.palette.divider),
            borderRadius: 1,
            ...LOG_ROW_CSS,
          }}
        >
          <Box sx={wrap ? undefined : { height: rowsHeight(visible.length, rowHeight, tallRows), position: 'relative' }}>
            {visible.slice(start, end).map((l, i) => {
              const idx = start + i;
              const isExpanded = l.kind === 'line' && expanded.has(l);
              return (
                <LineRow
                  key={idx}
                  line={l}
                  idx={idx}
                  top={wrap ? 0 : rowTop(idx, rowHeight, tallRows)}
                  wrap={wrap}
                  showPod={showPod}
                  showSource={showSource}
                  showContainer={allContainerNames.length > 1}
                  podLabel={l.kind === 'line' ? podLabels.get(l.pod) : undefined}
                  podColor={l.kind === 'line' && showSource ? (podColors.get(l.pod) ?? '#888') : undefined}
                  tsMode={tsMode}
                  view={view}
                  highlight={highlight}
                  find={find}
                  isCurrent={idx === currentMatch}
                  rowHeight={rowHeight}
                  expanded={isExpanded}
                  flash={flash === l}
                  reveal={revealRef.current === l}
                  onToggle={toggleExpanded}
                  onMeasure={measureRow}
                  onRevealed={revealed}
                />
              );
            })}
          </Box>
        </Box>
        {paused ? (
          <Chip
            color="primary"
            icon={<ArrowDownwardIcon />}
            label={[
              pendingCount ? `${pendingCount.toLocaleString()} new ${pendingCount === 1 ? 'line' : 'lines'}` : 'Paused',
              pendingMarkers ? `${pendingMarkers} ${pendingMarkers === 1 ? 'marker' : 'markers'}` : undefined,
              'resume',
            ]
              .filter(Boolean)
              .join(' · ')}
            onClick={resume}
            sx={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', boxShadow: 4, fontWeight: 600, zIndex: 1 }}
          />
        ) : null}
      </Box>
    </Box>
  );
}
