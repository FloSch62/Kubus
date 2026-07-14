import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import KeyboardCommandKeyIcon from '@mui/icons-material/KeyboardCommandKey';
import type { FavoriteItem, ResourceRef, SearchResult, SearchResultKind } from '@kubus/shared';
import { groupToPath } from '@kubus/shared';
import { useNavigate } from 'react-router';
import { useGlobalSearch } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useNavigationStore } from '../state/navigation.js';
import { useDockStore } from '../state/dock.js';
import { actionsForRef, usePaletteRunner, type PaletteAction } from '../actions/resource-actions.js';

function pathForRef(ref: ResourceRef): string {
  return `/r/${groupToPath(ref.group)}/${ref.version}/${ref.plural}`;
}

function detailPathForRef(ref: ResourceRef): string {
  const sel = `${ref.ctx}|${ref.namespace ?? ''}|${ref.name}`;
  return `${pathForRef(ref)}?sel=${encodeURIComponent(sel)}`;
}

function favoriteFromResult(result: SearchResult): FavoriteItem {
  return {
    id: result.id,
    title: result.title,
    subtitle: result.subtitle,
    path: result.ref ? detailPathForRef(result.ref) : result.path,
    ref: result.ref,
  };
}

interface StaticCommand {
  id: string;
  title: string;
  subtitle?: string;
  run: (deps: { navigate: (path: string) => void; toggleTheme: () => void; toggleDock: () => void }) => void;
}

const STATIC_COMMANDS: StaticCommand[] = [
  { id: 'cmd:theme', title: 'Toggle dark / light mode', run: (d) => d.toggleTheme() },
  { id: 'cmd:dock', title: 'Toggle terminal dock', run: (d) => d.toggleDock() },
  { id: 'cmd:overview', title: 'Go to Overview', run: (d) => d.navigate('/') },
  { id: 'cmd:events', title: 'Go to Events', run: (d) => d.navigate('/events') },
  { id: 'cmd:topology', title: 'Go to Topology', run: (d) => d.navigate('/topology') },
  { id: 'cmd:helm', title: 'Go to Helm Releases', run: (d) => d.navigate('/helm') },
  { id: 'cmd:forwards', title: 'Go to Port Forwards', run: (d) => d.navigate('/forwards') },
  { id: 'cmd:diff', title: 'Go to Diff', run: (d) => d.navigate('/diff') },
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
  const [toast, setToast] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
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
        navigate,
        toggleTheme,
        toggleDock: () => {
          const { open, setOpen } = useDockStore.getState();
          setOpen(!open);
        },
      });
      closeAll();
      return;
    }
    if (row.type === 'action') {
      if (!stage) return;
      if (row.action.kind === 'detail') {
        navigate(detailPathForRef(stage.ref));
        closeAll();
        return;
      }
      const { action } = row;
      const { ref } = stage;
      closeAll();
      runAction(action, ref)
        .then((text) => setToast({ severity: 'success', text }))
        .catch((err: unknown) => setToast({ severity: 'error', text: err instanceof Error ? err.message : String(err) }));
      return;
    }
    const item = row.result;
    const path = item.ref ? detailPathForRef(item.ref) : item.path ?? '/';
    navigate(path);
    closeAll();
  };

  const toggleFavorite = (item: SearchResult) => {
    if (isFavorite(item.id)) removeFavorite(item.id);
    else addFavorite(favoriteFromResult(item));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) activate(row);
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
          : `${rows.length} results — Tab for actions, > for commands`
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
                      <Chip size="small" label={row.result.kind} color={RESULT_CHIP_COLOR[row.result.kind]} variant="outlined" sx={{ mr: 0.5 }} />
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
      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={toast?.severity} variant="filled" onClose={() => setToast(null)}>
          {toast?.text}
        </Alert>
      </Snackbar>
    </>
  );
}
