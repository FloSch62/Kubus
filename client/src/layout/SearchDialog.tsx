import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckIcon from '@mui/icons-material/Check';
import KeyboardCommandKeyIcon from '@mui/icons-material/KeyboardCommandKey';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import FilterListIcon from '@mui/icons-material/FilterList';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import AddIcon from '@mui/icons-material/Add';
import ContrastIcon from '@mui/icons-material/Contrast';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import RestoreIcon from '@mui/icons-material/Restore';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import { useQueries } from '@tanstack/react-query';
import { groupToPath, type ContextInfo, type FavoriteItem, type KubeObject, type ResourceRef, type SearchResult } from '@kubus/shared';
import { useNavigate } from 'react-router';
import { detailPathForRef } from '../resource-links.js';
import { resourceUrl, useApiResourcesForContexts, useConnectContext, useContexts, useGlobalSearch, useNamespaces } from '../api/queries.js';
import { apiFetch } from '../api/http.js';
import { resolveFavorites } from '../favorite-scope.js';
import { useClustersStore } from '../state/clusters.js';
import { useNavigationStore } from '../state/navigation.js';
import { useRecentStore } from '../state/recent.js';
import { useDockStore } from '../state/dock.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { GO_TARGETS, toggleNavRail } from '../shortcuts.js';
import { showToast } from '../state/toast.js';
import { actionsForRef, usePaletteRunner, type PaletteAction } from '../actions/resource-actions.js';
import { RowKeyHint } from '../components/RowKeyHint.js';
import { Kbd } from '../components/Kbd.js';
import { StatusChip } from '../components/StatusChip.js';
import { ContextHealthDot } from '../components/ContextHealthDot.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { tabMeta } from './tab-meta.js';
import {
  buildResultEntries,
  groupStatusSummary,
  hasPaletteStatus,
  highlightParts,
  paletteStatus,
  type PaletteStatus,
  type ResultEntry,
} from './palette-model.js';

function favoriteFromResult(result: SearchResult): FavoriteItem {
  return {
    id: result.id,
    title: result.title,
    subtitle: result.subtitle,
    path: result.ref ? detailPathForRef(result.ref) : result.path,
    ref: result.ref,
  };
}

function resultFromRef(id: string, ref: ResourceRef): SearchResult {
  return {
    id,
    kind: 'resource',
    title: `${ref.kind}/${ref.name}`,
    subtitle: `${ref.ctx}${ref.namespace ? ` · ${ref.namespace}` : ''}`,
    score: 1,
    ref,
    path: `/r/${groupToPath(ref.group)}/${ref.version}/${ref.plural}`,
  };
}

interface CommandDeps {
  navigate: (path: string) => void;
  toggleTheme: () => void;
  toggleDock: () => void;
  toggleNav: () => void;
  openSettings: () => void;
  openShortcuts: () => void;
  newTab: () => void;
  reopenTab: () => void;
  openStage: (stage: 'clusters' | 'namespaces') => void;
}

interface StaticCommand {
  id: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactElement;
  /** Key hint shown at the row's end. */
  keys?: string[];
  /** Keeps the palette open (the command opens another palette stage). */
  staysOpen?: boolean;
  run: (deps: CommandDeps) => void;
}

const SWITCH_CLUSTER: StaticCommand = {
  id: 'cmd:switch-cluster',
  title: 'Switch cluster…',
  icon: <HubOutlinedIcon />,
  staysOpen: true,
  run: (d) => d.openStage('clusters'),
};
const CHANGE_NAMESPACE: StaticCommand = {
  id: 'cmd:namespace',
  title: 'Change namespace…',
  icon: <FilterListIcon />,
  staysOpen: true,
  run: (d) => d.openStage('namespaces'),
};
const INSTALL_CHART: StaticCommand = {
  id: 'cmd:install-chart',
  title: 'Install a Helm chart…',
  icon: <SailingOutlinedIcon />,
  run: (d) => d.navigate('/helm?install=1'),
};
const NEW_TAB: StaticCommand = { id: 'cmd:newtab', title: 'New tab', icon: <AddIcon />, keys: ['Alt', 'T'], run: (d) => d.newTab() };
const TOGGLE_THEME: StaticCommand = { id: 'cmd:theme', title: 'Toggle dark / light mode', icon: <ContrastIcon />, run: (d) => d.toggleTheme() };
const SHORTCUTS: StaticCommand = { id: 'cmd:shortcuts', title: 'Keyboard shortcuts', icon: <KeyboardOutlinedIcon />, keys: ['?'], run: (d) => d.openShortcuts() };

const STATIC_COMMANDS: StaticCommand[] = [
  SWITCH_CLUSTER,
  CHANGE_NAMESPACE,
  INSTALL_CHART,
  TOGGLE_THEME,
  { id: 'cmd:dock', title: 'Toggle terminal dock', icon: <TerminalIcon />, run: (d) => d.toggleDock() },
  { id: 'cmd:nav', title: 'Toggle navigation rail', icon: <MenuOpenIcon />, run: (d) => d.toggleNav() },
  NEW_TAB,
  { id: 'cmd:reopen', title: 'Reopen closed tab', icon: <RestoreIcon />, run: (d) => d.reopenTab() },
  { id: 'cmd:settings', title: 'Open settings', icon: <SettingsOutlinedIcon />, run: (d) => d.openSettings() },
  SHORTCUTS,
  { id: 'cmd:overview', title: 'Go to Overview', run: (d) => d.navigate('/') },
  { id: 'cmd:events', title: 'Go to Events', run: (d) => d.navigate('/events') },
  { id: 'cmd:topology', title: 'Go to Topology', run: (d) => d.navigate('/topology') },
  { id: 'cmd:metrics', title: 'Go to Metrics', run: (d) => d.navigate('/metrics') },
  { id: 'cmd:network', title: 'Go to Network', run: (d) => d.navigate('/network') },
  { id: 'cmd:helm', title: 'Go to Helm Releases', run: (d) => d.navigate('/helm') },
  { id: 'cmd:forwards', title: 'Go to Port Forwards', run: (d) => d.navigate('/forwards') },
  { id: 'cmd:diff', title: 'Go to Diff', run: (d) => d.navigate('/diff') },
  { id: 'cmd:audit', title: 'Go to Audit', run: (d) => d.navigate('/audit') },
];

/** Commands the empty palette offers without typing `>`. */
const EMPTY_STATE_ACTIONS = [SWITCH_CLUSTER, CHANGE_NAMESPACE, INSTALL_CHART, NEW_TAB, TOGGLE_THEME];

/** Go-to destinations the empty palette lists (with their `g` sequence). */
const EMPTY_STATE_GO_KEYS = ['o', 'p', 'd', 's', 'e', 'h'];
const EMPTY_STATE_GO = GO_TARGETS.filter((t) => EMPTY_STATE_GO_KEYS.includes(t.key));

/** How many recently opened resources the empty palette shows. */
const RECENT_SHOWN = 5;

/** Status lookups per query: enough for the rows people actually see. */
const STATUS_FETCH_LIMIT = 24;

type Stage = { type: 'resource'; ref: ResourceRef; title: string } | { type: 'clusters' } | { type: 'namespaces' };

type Row =
  | ResultEntry
  | { type: 'command'; id: string; section?: string; command: StaticCommand }
  | { type: 'goto'; id: string; section: string; target: (typeof GO_TARGETS)[number] }
  | { type: 'action'; id: string; section?: string; action: PaletteAction }
  | { type: 'context'; id: string; section?: string; info: ContextInfo }
  | { type: 'namespace'; id: string; section?: string; namespace: string | null };

function matchesFilter(text: string, filter: string): boolean {
  return !filter || text.toLowerCase().includes(filter);
}

/** Stable `combine` for useQueries: just the data, in query order. */
const pickData = (results: Array<{ data?: KubeObject }>) => results.map((r) => r.data);

/** Status lookups for the resources a row list shows, keyed by result id. */
function useResultStatuses(rows: Row[]): Map<string, PaletteStatus> {
  const refs = useMemo(() => {
    const out: Array<{ id: string; ref: ResourceRef }> = [];
    const push = (result: SearchResult) => {
      if (out.length >= STATUS_FETCH_LIMIT || !result.ref || !hasPaletteStatus(result.ref.kind)) return;
      if (!out.some((r) => r.id === result.id)) out.push({ id: result.id, ref: result.ref });
    };
    for (const row of rows) {
      if (row.type === 'result') push(row.result);
      else if (row.type === 'group') row.members.slice(0, 8).forEach(push);
    }
    return out;
  }, [rows]);
  const objects = useQueries({
    combine: pickData,
    queries: refs.map(({ ref }) => {
      const sel = { ctx: ref.ctx, group: ref.group, version: ref.version, plural: ref.plural, name: ref.name, namespace: ref.namespace };
      return {
        queryKey: ['resource', sel],
        queryFn: () => apiFetch<KubeObject>(resourceUrl(sel.ctx, sel.group, sel.version, sel.plural, sel.name, sel.namespace)),
        staleTime: 15_000,
        retry: false,
      };
    }),
  });
  return useMemo(() => {
    const map = new Map<string, PaletteStatus>();
    refs.forEach(({ id, ref }, i) => {
      const obj = objects[i];
      const status = obj?.metadata ? paletteStatus(ref.kind, obj) : undefined;
      if (status?.status) map.set(id, status);
    });
    return map;
  }, [refs, objects]);
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? (
          <Box
            key={i}
            component="mark"
            sx={(theme) => ({
              bgcolor: alpha(theme.palette.warning.main, theme.palette.mode === 'dark' ? 0.3 : 0.22),
              color: 'inherit',
              borderRadius: 0.5,
              px: 0.125,
            })}
          >
            {part.text}
          </Box>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' }}>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
      <span>{label}</span>
    </Box>
  );
}

/** Icon for a search result: the kind's nav-group icon, or the page's own. */
function resultIcon(result: SearchResult): React.ReactElement {
  if (result.ref) return tabMeta(`/r/${groupToPath(result.ref.group)}/${result.ref.version}/${result.ref.plural}`).icon;
  return tabMeta(result.path ?? '/').icon;
}

/** Name and muted detail line for a result row. */
function resultText(result: SearchResult, multiCluster: boolean): { primary: string; secondary: string } {
  const ref = result.ref;
  if (!ref) return { primary: result.title, secondary: result.subtitle ?? '' };
  const detail = [ref.kind, ref.namespace, multiCluster ? ref.ctx : undefined].filter(Boolean).join(' · ');
  return { primary: ref.name, secondary: detail };
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const selected = useClustersStore((s) => s.selected);
  const setSelected = useClustersStore((s) => s.setSelected);
  const toggleContext = useClustersStore((s) => s.toggleContext);
  const namespaceFilter = useClustersStore((s) => s.namespaces);
  const setNamespaces = useClustersStore((s) => s.setNamespaces);
  const toggleTheme = useClustersStore((s) => s.toggleTheme);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [stage, setStage] = useState<Stage | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const deferredQuery = useDeferredValue(query);
  const commandMode = query.startsWith('>');
  const searchQuery = stage || commandMode ? '' : query;
  const { data: results, isFetching } = useGlobalSearch(selected, searchQuery);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const { data: contexts } = useContexts({ poll: false });
  const { data: namespaceOptions } = useNamespaces(stage?.type === 'namespaces' ? selected : []);
  const connect = useConnectContext();
  const storedFavorites = useNavigationStore((s) => s.favorites);
  // The empty palette lists favorites, so it follows the same cluster scoping
  // as the sidebar — otherwise another cluster's CRDs come back here.
  const favorites = useMemo(
    () => resolveFavorites(storedFavorites, { selected, byContext: apiResources?.byContext, errors: apiResources?.errors }),
    [storedFavorites, selected, apiResources],
  );
  const recent = useRecentStore((s) => s.recent);
  const addFavorite = useNavigationStore((s) => s.addFavorite);
  const removeFavorite = useNavigationStore((s) => s.removeFavorite);
  const isFavorite = useNavigationStore((s) => s.isFavorite);
  const navigate = useNavigate();
  const runAction = usePaletteRunner();
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const multiCluster = selected.length > 1;

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setStage(null);
      setActiveIndex(0);
      focusInput();
    }
  }, [focusInput, open]);

  useEffect(() => {
    if (open) focusInput();
  }, [focusInput, open, stage]);

  const rows = useMemo<Row[]>(() => {
    const filter = deferredQuery.trim().toLowerCase();
    if (stage?.type === 'resource') {
      return actionsForRef(stage.ref)
        .filter((a) => matchesFilter(a.title, filter))
        .map((action) => ({ type: 'action', id: action.id, action }));
    }
    if (stage?.type === 'clusters') {
      return (contexts ?? [])
        .filter((info) => matchesFilter(info.name, filter))
        .map((info) => ({ type: 'context', id: `ctx:${info.name}`, info }));
    }
    if (stage?.type === 'namespaces') {
      const all: Row = { type: 'namespace', id: 'ns:*', namespace: null };
      const names = (namespaceOptions ?? []).filter((ns) => matchesFilter(ns, filter)).map<Row>((namespace) => ({ type: 'namespace', id: `ns:${namespace}`, namespace }));
      return filter && !matchesFilter('all namespaces', filter) ? names : [all, ...names];
    }
    if (deferredQuery.startsWith('>')) {
      const f = deferredQuery.slice(1).trim().toLowerCase();
      return STATIC_COMMANDS.filter((c) => matchesFilter(c.title, f)).map((command) => ({ type: 'command', id: command.id, command }));
    }
    if (deferredQuery.trim().length > 1) return buildResultEntries(results ?? [], expanded);

    // Empty palette: favorites, recently opened resources, then places to go and things to do.
    const out: Row[] = favorites.map<Row>((f) => ({
      type: 'result',
      id: f.id,
      section: 'Favorites',
      result: { id: f.id, kind: f.ref ? 'resource' : 'page', title: f.title, subtitle: f.subtitle, score: 1, ref: f.ref, path: f.path },
    }));
    const favoriteIds = new Set(favorites.map((f) => f.id));
    const recentRows = recent
      .filter((r) => selected.includes(r.ref.ctx) && !favoriteIds.has(r.id))
      .slice(0, RECENT_SHOWN)
      .map<Row>((r) => ({ type: 'result', id: `recent:${r.id}`, section: 'Recent', result: resultFromRef(r.id, r.ref) }));
    out.push(...recentRows);
    out.push(...EMPTY_STATE_GO.map<Row>((target) => ({ type: 'goto', id: `go:${target.key}`, section: 'Go to', target })));
    out.push(...EMPTY_STATE_ACTIONS.map<Row>((command) => ({ type: 'command', id: command.id, section: 'Actions', command })));
    return out;
  }, [stage, deferredQuery, results, favorites, recent, selected, expanded, contexts, namespaceOptions]);

  const statuses = useResultStatuses(rows);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, stage]);

  useEffect(() => {
    setExpanded(new Set());
  }, [searchQuery]);

  const closeAll = () => {
    setStage(null);
    onClose();
  };

  const enterStage = (result: SearchResult) => {
    if (!result.ref) return;
    setStage({ type: 'resource', ref: result.ref, title: result.title });
    setQuery('');
  };

  const openStage = (type: 'clusters' | 'namespaces') => {
    setStage({ type });
    setQuery('');
  };

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Make `names` the selection, connecting and disconnecting only the deltas (as the cluster picker does). */
  const applyClusterSelection = (names: string[]) => {
    const next = new Set(names);
    const cur = new Set(selected);
    for (const name of names) if (!cur.has(name)) connect.mutate({ ctx: name, connect: true });
    for (const name of selected) if (!next.has(name)) connect.mutate({ ctx: name, connect: false });
    setSelected(names);
  };

  const toggleCluster = (name: string) => {
    const isSelected = selected.includes(name);
    toggleContext(name);
    connect.mutate({ ctx: name, connect: !isSelected });
  };

  const toggleNamespace = (namespace: string | null) => {
    if (namespace === null) setNamespaces([]);
    else setNamespaces(namespaceFilter.includes(namespace) ? namespaceFilter.filter((n) => n !== namespace) : [...namespaceFilter, namespace]);
  };

  const runCommand = (command: StaticCommand) => {
    command.run({
      navigate: (path) => void navigate(path),
      toggleTheme,
      toggleDock: () => {
        const { open, setOpen } = useDockStore.getState();
        setOpen(!open);
      },
      toggleNav: toggleNavRail,
      openSettings: () => useUiStore.getState().setSettingsOpen(true),
      openShortcuts: () => useUiStore.getState().setShortcutsOpen(true),
      newTab: () => {
        useTabsStore.getState().openTab('/');
        void navigate('/');
      },
      reopenTab: () => {
        const before = useTabsStore.getState().activeId;
        useTabsStore.getState().reopenTab();
        const s = useTabsStore.getState();
        if (s.activeId === before) return;
        const active = s.tabs.find((t) => t.id === s.activeId);
        if (active) void navigate(active.path);
      },
      openStage,
    });
    if (!command.staysOpen) closeAll();
  };

  const activate = (row: Row) => {
    switch (row.type) {
      case 'command':
        runCommand(row.command);
        return;
      case 'goto':
        void navigate(row.target.path);
        closeAll();
        return;
      case 'group':
        toggleGroup(row.id);
        return;
      case 'context':
        applyClusterSelection([row.info.name]);
        closeAll();
        return;
      case 'namespace':
        setNamespaces(row.namespace === null ? [] : [row.namespace]);
        closeAll();
        return;
      case 'action': {
        if (stage?.type !== 'resource') return;
        if (row.action.kind === 'detail') {
          void navigate(detailPathForRef(stage.ref));
          closeAll();
          return;
        }
        const { action } = row;
        const { ref } = stage;
        closeAll();
        void runAction(action, ref)
          .then((text: string | undefined) => {
            // Actions whose result is visible on their own (a logs or shell tab) resolve without text.
            if (text) showToast('success', text);
          })
          .catch((err: unknown) => showToast('error', err instanceof Error ? err.message : String(err)));
        return;
      }
      case 'result': {
        const item = row.result;
        const path = item.ref ? detailPathForRef(item.ref) : (item.path ?? '/');
        void navigate(path);
        closeAll();
      }
    }
  };

  const toggleFavorite = (item: SearchResult) => {
    if (isFavorite(item.id)) removeFavorite(item.id);
    else addFavorite(favoriteFromResult(item));
  };

  // Cmd/Ctrl+Enter opens a result in a new tab, Shift+Enter in a background
  // tab (the dialog stays open, so several can be queued). In the cluster and
  // namespace stages the same keys add to or remove from the selection.
  const openInNewTab = (row: Row, background: boolean): boolean => {
    if (row.type === 'context') {
      toggleCluster(row.info.name);
      return true;
    }
    if (row.type === 'namespace') {
      toggleNamespace(row.namespace);
      return true;
    }
    if (row.type !== 'result') return false;
    const item = row.result;
    const path = item.ref ? detailPathForRef(item.ref) : (item.path ?? '/');
    useTabsStore.getState().openTab(path, { afterActive: true, activate: !background });
    if (!background) {
      void navigate(path);
      closeAll();
    }
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      setActiveIndex((i) => (e.key === 'PageDown' ? Math.min(i + 8, rows.length - 1) : Math.max(i - 8, 0)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (!row) return;
      if ((e.metaKey || e.ctrlKey || e.shiftKey) && openInNewTab(row, e.shiftKey)) return;
      activate(row);
    } else if (e.key === 'ArrowLeft' && stage && query === '') {
      e.preventDefault();
      setStage(null);
    } else if ((e.key === 'Tab' || e.key === 'ArrowRight') && !stage) {
      const row = rows[activeIndex];
      if (row?.type === 'result' && row.result.ref) {
        e.preventDefault();
        enterStage(row.result);
      } else if (row?.type === 'group') {
        e.preventDefault();
        if (!row.expanded) toggleGroup(row.id);
      }
    } else if (e.key === 'ArrowLeft' && !stage) {
      const row = rows[activeIndex];
      if (row?.type === 'group' && row.expanded) {
        e.preventDefault();
        toggleGroup(row.id);
      }
    } else if (e.key === 'Escape' && stage) {
      e.preventDefault();
      e.stopPropagation();
      setStage(null);
      setQuery('');
    } else if (e.key === 'Backspace' && stage && query === '') {
      e.preventDefault();
      setStage(null);
    }
  };

  // Keep the active row in view while navigating with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const clusterNote = selected.length > 1 ? ` · ${selected.length} clusters` : '';
  const status =
    stage?.type === 'resource'
      ? `Actions for ${stage.title} · keys work on a focused list row`
      : stage?.type === 'clusters'
        ? 'Switch cluster'
        : stage?.type === 'namespaces'
          ? 'Filter by namespace'
          : commandMode
            ? 'Commands'
            : query.trim().length > 1
              ? isFetching && !results
                ? 'Searching…'
                : `${results?.length ?? 0} results${clusterNote}`
              : '';
  const keyHints: Array<{ keys: string[]; label: string }> = stage
    ? stage.type === 'resource'
      ? [
          { keys: ['↵'], label: 'run' },
          { keys: ['←'], label: 'back' },
        ]
      : [
          { keys: ['↵'], label: stage.type === 'clusters' ? 'switch' : 'only this' },
          { keys: [`${HOTKEY_MOD_LABEL}↵`], label: 'add / remove' },
          { keys: ['←'], label: 'back' },
        ]
    : [
        { keys: ['↑↓'], label: 'move' },
        { keys: ['↵'], label: 'open' },
        { keys: ['Tab'], label: 'actions' },
        { keys: [`${HOTKEY_MOD_LABEL}↵`], label: 'new tab' },
        { keys: ['>'], label: 'commands' },
      ];

  const placeholder =
    stage?.type === 'resource'
      ? 'Filter actions…'
      : stage?.type === 'clusters'
        ? 'Filter clusters…'
        : stage?.type === 'namespaces'
          ? 'Filter namespaces…'
          : 'Search resources, pages, kinds… (> for commands)';
  const stageLabel = stage?.type === 'resource' ? stage.title : stage?.type === 'clusters' ? 'Clusters' : stage?.type === 'namespaces' ? 'Namespaces' : '';

  const renderRow = (row: Row, idx: number) => {
    const active = idx === activeIndex;
    const common = {
      'data-idx': idx,
      selected: active,
      onClick: () => activate(row),
      onMouseEnter: () => setActiveIndex(idx),
      // Keep focus (and with it the keyboard) in the search field when a row is clicked.
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      tabIndex: -1,
    };
    const rowSx = { borderRadius: 1, minHeight: 34, py: 0.25, px: 1, gap: 1.25 } as const;
    const iconBox = (icon: React.ReactNode, indent = false) => (
      <Box sx={{ display: 'flex', color: 'text.secondary', ml: indent ? 2.5 : 0, '& svg': { fontSize: 17 } }}>{icon}</Box>
    );
    const textLine = (primary: React.ReactNode, secondary?: React.ReactNode) => (
      <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 500, flexShrink: 1, minWidth: 0 }}>
          {primary}
        </Typography>
        {secondary && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 100, minWidth: 0 }}>
            {secondary}
          </Typography>
        )}
      </Box>
    );

    if (row.type === 'result') {
      const item = row.result;
      const { primary, secondary } = resultText(item, multiCluster);
      const itemStatus = statuses.get(item.id);
      const favorite = isFavorite(item.id);
      return (
        <ListItemButton key={row.id} {...common} sx={rowSx}>
          {iconBox(resultIcon(item), row.indent)}
          {textLine(<Highlighted text={primary} query={searchQuery} />, secondary)}
          {itemStatus && <StatusChip status={itemStatus.status} label={itemStatus.label} />}
          {item.ref && (
            <Tooltip title="Actions (Tab)">
              <IconButton
                size="small"
                aria-label={`Actions for ${item.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  enterStage(item);
                }}
                sx={{ opacity: active ? 1 : 0.35 }}
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={favorite ? 'Remove favorite' : 'Add favorite'}>
            <IconButton
              size="small"
              aria-label={favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(item);
              }}
              sx={{ opacity: favorite || active ? 1 : 0.35 }}
            >
              {favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </ListItemButton>
      );
    }
    if (row.type === 'group') {
      const memberStatuses = row.members.map((m) => statuses.get(m.id)?.status).filter((s): s is string => !!s);
      const summary = memberStatuses.length ? groupStatusSummary(memberStatuses) : '';
      const worst = memberStatuses.find((s) => s !== 'Running') ?? memberStatuses[0];
      const detail = [`${row.members.length} ${row.kind}s`, row.namespace, multiCluster ? row.ctx : undefined].filter(Boolean).join(' · ');
      return (
        <ListItemButton key={row.id} {...common} aria-expanded={row.expanded} sx={rowSx}>
          {iconBox(resultIcon(row.members[0]!))}
          {textLine(
            <>
              <Highlighted text={`${row.base}-`} query={searchQuery} />
              <Box component="span" sx={{ color: 'text.secondary' }}>
                …
              </Box>
            </>,
            detail,
          )}
          {worst && <StatusChip status={worst} label={summary} />}
          <ExpandMoreIcon fontSize="small" sx={{ color: 'text.secondary', transform: row.expanded ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }} />
        </ListItemButton>
      );
    }
    if (row.type === 'goto') {
      return (
        <ListItemButton key={row.id} {...common} sx={rowSx}>
          {iconBox(tabMeta(row.target.path).icon)}
          {textLine(row.target.label)}
          <KeyHint keys={['G', row.target.key.toUpperCase()]} label="" />
        </ListItemButton>
      );
    }
    if (row.type === 'command') {
      return (
        <ListItemButton key={row.id} {...common} sx={rowSx}>
          {iconBox(row.command.icon ?? <KeyboardCommandKeyIcon />)}
          {textLine(<Highlighted text={row.command.title} query={commandMode ? query.slice(1) : ''} />, row.command.subtitle)}
          {row.command.keys && <KeyHint keys={row.command.keys} label="" />}
        </ListItemButton>
      );
    }
    if (row.type === 'context') {
      const isSelected = selected.includes(row.info.name);
      return (
        <ListItemButton key={row.id} {...common} sx={rowSx}>
          <Box sx={{ width: 17, display: 'flex', justifyContent: 'center' }}>
            <ContextHealthDot info={row.info} size={9} />
          </Box>
          {textLine(<Highlighted text={row.info.name} query={query} />, [row.info.kubernetesVersion, row.info.server].filter(Boolean).join(' · '))}
          {isSelected && <CheckIcon fontSize="small" color="primary" aria-label="Selected" />}
        </ListItemButton>
      );
    }
    if (row.type === 'namespace') {
      const isSelected = row.namespace === null ? namespaceFilter.length === 0 : namespaceFilter.includes(row.namespace);
      return (
        <ListItemButton key={row.id} {...common} sx={rowSx}>
          {iconBox(<FolderOutlinedIcon />)}
          {textLine(row.namespace === null ? 'All namespaces' : <Highlighted text={row.namespace} query={query} />)}
          {isSelected && <CheckIcon fontSize="small" color="primary" aria-label="Selected" />}
        </ListItemButton>
      );
    }
    return (
      <ListItemButton key={row.id} {...common} sx={rowSx}>
        {textLine(
          <Box component="span" sx={row.action.danger ? { color: 'error.main' } : undefined}>
            {row.action.title}
          </Box>,
        )}
        {row.action.rowKey && <RowKeyHint action={row.action.rowKey} title="Key for this action on a focused list row" />}
      </ListItemButton>
    );
  };

  const emptyText =
    stage?.type === 'namespaces' && !namespaceOptions
      ? 'Loading namespaces…'
      : query.trim().length > 1 && isFetching && !results
        ? 'Searching…'
        : 'No matches.';

  return (
    <>
      <Dialog
        open={open}
        onClose={closeAll}
        maxWidth="sm"
        fullWidth
        slotProps={{
          container: { sx: { alignItems: 'flex-start' } },
          transition: { onEntered: focusInput },
        }}
      >
        <DialogContent sx={{ p: 1.25, pb: 0.75 }}>
          <TextField
            autoFocus
            inputRef={inputRef}
            fullWidth
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    {stage ? (
                      <Chip size="small" icon={<KeyboardCommandKeyIcon sx={{ fontSize: 13 }} />} label={stageLabel} onDelete={() => setStage(null)} />
                    ) : (
                      <SearchIcon fontSize="small" />
                    )}
                  </InputAdornment>
                ),
              },
            }}
          />
          <List ref={listRef} dense disablePadding sx={{ maxHeight: 460, overflow: 'auto', mt: 0.75 }}>
            {rows.map((row, idx) => {
              const section = 'section' in row ? row.section : undefined;
              const prev = idx > 0 ? rows[idx - 1] : undefined;
              const prevSection = prev && 'section' in prev ? prev.section : undefined;
              return (
                <Fragment key={row.id}>
                  {section && section !== prevSection && (
                    <Typography
                      component="li"
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', px: 1, pt: idx === 0 ? 0.5 : 1.25, pb: 0.5, fontWeight: 600, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                    >
                      {section}
                    </Typography>
                  )}
                  {renderRow(row, idx)}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <Typography component="li" variant="body2" color="text.secondary" sx={{ display: 'block', px: 1, py: 2 }}>
                {emptyText}
              </Typography>
            )}
          </List>
        </DialogContent>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            flexWrap: 'wrap',
            rowGap: 0.5,
            px: 1.75,
            py: 0.75,
            borderTop: 1,
            borderColor: 'divider',
            color: 'text.secondary',
            fontSize: 11.5,
          }}
        >
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, flexShrink: 1 }}>
            {status}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {keyHints.map((h) => (
            <KeyHint key={h.label} keys={h.keys} label={h.label} />
          ))}
        </Box>
      </Dialog>
    </>
  );
}
