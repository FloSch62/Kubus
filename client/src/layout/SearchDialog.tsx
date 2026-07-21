import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import KeyboardCommandKeyIcon from '@mui/icons-material/KeyboardCommandKey';
import type { FavoriteItem, ResourceRef, SearchResult, SearchResultKind } from '@kubus/shared';
import { useNavigate } from 'react-router';
import { detailPathForRef } from '../resource-links.js';
import { useGlobalSearch } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useNavigationStore } from '../state/navigation.js';
import { useDockStore } from '../state/dock.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { toggleNavRail } from '../shortcuts.js';
import { showToast } from '../state/toast.js';
import { actionsForRef, usePaletteRunner, type PaletteAction } from '../actions/resource-actions.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';

function favoriteFromResult(result: SearchResult): FavoriteItem {
  return {
    id: result.id,
    title: result.title,
    subtitle: result.subtitle,
    path: result.ref ? detailPathForRef(result.ref) : result.path,
    ref: result.ref,
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
}

interface StaticCommand {
  id: string;
  title: string;
  subtitle?: string;
  run: (deps: CommandDeps) => void;
}

const STATIC_COMMANDS: StaticCommand[] = [
  { id: 'cmd:theme', title: 'Toggle dark / light mode', run: (d) => d.toggleTheme() },
  { id: 'cmd:dock', title: 'Toggle terminal dock', run: (d) => d.toggleDock() },
  { id: 'cmd:nav', title: 'Toggle navigation rail', run: (d) => d.toggleNav() },
  { id: 'cmd:newtab', title: 'New tab', run: (d) => d.newTab() },
  { id: 'cmd:reopen', title: 'Reopen closed tab', run: (d) => d.reopenTab() },
  { id: 'cmd:settings', title: 'Open settings', run: (d) => d.openSettings() },
  { id: 'cmd:shortcuts', title: 'Keyboard shortcuts', run: (d) => d.openShortcuts() },
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

type Row =
  | { type: 'result'; result: SearchResult }
  | { type: 'command'; command: StaticCommand }
  | { type: 'action'; action: PaletteAction };

const RESULT_CHIP_COLOR: Record<SearchResultKind, 'info' | 'secondary' | 'success'> = {
  resource: 'info',
  kind: 'secondary',
  page: 'success',
};

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const selected = useClustersStore((s) => s.selected);
  const toggleTheme = useClustersStore((s) => s.toggleTheme);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [stage, setStage] = useState<{ ref: ResourceRef; title: string } | null>(null);
  const deferredQuery = useDeferredValue(query);
  const commandMode = query.startsWith('>');
  const searchQuery = stage || commandMode ? '' : query;
  const { data: results, isFetching } = useGlobalSearch(selected, searchQuery);
  const favorites = useNavigationStore((s) => s.favorites);
  const addFavorite = useNavigationStore((s) => s.addFavorite);
  const removeFavorite = useNavigationStore((s) => s.removeFavorite);
  const isFavorite = useNavigationStore((s) => s.isFavorite);
  const navigate = useNavigate();
  const runAction = usePaletteRunner();
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (stage) {
      const f = deferredQuery.trim().toLowerCase();
      return actionsForRef(stage.ref)
        .filter((a) => !f || a.title.toLowerCase().includes(f))
        .map((action) => ({ type: 'action', action }));
    }
    if (deferredQuery.startsWith('>')) {
      const f = deferredQuery.slice(1).trim().toLowerCase();
      return STATIC_COMMANDS.filter((c) => !f || c.title.toLowerCase().includes(f)).map((command) => ({ type: 'command', command }));
    }
    if (deferredQuery.trim().length > 1) return (results ?? []).map((result) => ({ type: 'result', result }));
    return favorites.map<Row>((f) => ({
      type: 'result',
      result: { id: f.id, kind: f.ref ? 'resource' : 'page', title: f.title, subtitle: f.subtitle, score: 1, ref: f.ref, path: f.path },
    }));
  }, [stage, deferredQuery, results, favorites]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, stage]);

  const closeAll = () => {
    setStage(null);
    onClose();
  };

  const enterStage = (result: SearchResult) => {
    if (!result.ref) return;
    setStage({ ref: result.ref, title: result.title });
    setQuery('');
  };

  const activate = (row: Row) => {
    if (row.type === 'command') {
      row.command.run({
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
      });
      closeAll();
      return;
    }
    if (row.type === 'action') {
      if (!stage) return;
      if (row.action.kind === 'detail') {
        void navigate(detailPathForRef(stage.ref));
        closeAll();
        return;
      }
      const { action } = row;
      const { ref } = stage;
      closeAll();
      void runAction(action, ref)
        .then((text) => showToast('success', text))
        .catch((err: unknown) => showToast('error', err instanceof Error ? err.message : String(err)));
      return;
    }
    const item = row.result;
    const path = item.ref ? detailPathForRef(item.ref) : item.path ?? '/';
    void navigate(path);
    closeAll();
  };

  const toggleFavorite = (item: SearchResult) => {
    if (isFavorite(item.id)) removeFavorite(item.id);
    else addFavorite(favoriteFromResult(item));
  };

  // Cmd/Ctrl+Enter opens a result in a new tab, Shift+Enter in a background
  // tab (the dialog stays open, so several can be queued).
  const openInNewTab = (row: Row, background: boolean): boolean => {
    if (row.type !== 'result') return false;
    const item = row.result;
    const path = item.ref ? detailPathForRef(item.ref) : item.path ?? '/';
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

  const hint = stage
    ? `Actions — ${stage.title}`
    : commandMode
      ? 'Commands'
      : query.trim().length > 1
        ? isFetching
          ? 'Searching…'
          : `${rows.length} results — Tab actions · ${HOTKEY_MOD_LABEL}↵ new tab · > commands`
        : favorites.length
          ? 'Favorites — type to search, > for commands'
          : 'Type to search, > for commands';

  return (
    <>
      <Dialog open={open} onClose={closeAll} maxWidth="sm" fullWidth slotProps={{ transition: { onEntered: focusInput } }}>
        <DialogContent sx={{ p: 1.25 }}>
          <TextField
            autoFocus
            inputRef={inputRef}
            fullWidth
            placeholder={stage ? 'Filter actions…' : 'Search resources, pages, kinds… (> for commands)'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    {stage ? (
                      <Chip size="small" icon={<KeyboardCommandKeyIcon sx={{ fontSize: 13 }} />} label={stage.title} onDelete={() => setStage(null)} />
                    ) : (
                      <SearchIcon fontSize="small" />
                    )}
                  </InputAdornment>
                ),
              },
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {hint}
            </Typography>
            {selected.length > 0 && <Chip size="small" label={`${selected.length} cluster${selected.length === 1 ? '' : 's'}`} variant="outlined" />}
          </Box>
          <List ref={listRef} dense disablePadding sx={{ maxHeight: 440, overflow: 'auto' }}>
            {rows.map((row, idx) => {
              const key = row.type === 'result' ? row.result.id : row.type === 'command' ? row.command.id : row.action.id;
              return (
                <ListItemButton
                  key={key}
                  data-idx={idx}
                  selected={idx === activeIndex}
                  onClick={() => activate(row)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  sx={{ borderRadius: 1 }}
                >
                  {row.type === 'result' && (
                    <>
                      <ListItemText
                        primary={row.result.title}
                        secondary={row.result.subtitle}
                        slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                      />
                      {/* Resources dominate the results and already name their
                          kind in the title — a chip on every row is noise, so
                          only the rarer kind/page results get tagged. */}
                      {row.result.kind !== 'resource' && (
                        <Chip size="small" label={row.result.kind} color={RESULT_CHIP_COLOR[row.result.kind]} variant="outlined" sx={{ mr: 0.5 }} />
                      )}
                      {row.result.ref && (
                        <Tooltip title="Actions (Tab)">
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              enterStage(row.result);
                            }}
                          >
                            <ChevronRightIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Tooltip title={isFavorite(row.result.id) ? 'Remove favorite' : 'Add favorite'}>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(row.result);
                          }}
                        >
                          {isFavorite(row.result.id) ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
                  {row.type === 'command' && <ListItemText primary={row.command.title} secondary={row.command.subtitle} />}
                  {row.type === 'action' && (
                    <ListItemText
                      primary={row.action.title}
                      slotProps={{ primary: { sx: row.action.danger ? { color: 'error.main' } : undefined } }}
                    />
                  )}
                </ListItemButton>
              );
            })}
            {rows.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
                No matches.
              </Typography>
            )}
          </List>
        </DialogContent>
      </Dialog>
    </>
  );
}
