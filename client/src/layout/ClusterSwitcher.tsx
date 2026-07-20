import { useEffect, useMemo, useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import BlockIcon from '@mui/icons-material/Block';
import CircleIcon from '@mui/icons-material/Circle';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import GridViewIcon from '@mui/icons-material/GridView';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import ShieldIcon from '@mui/icons-material/Shield';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import TuneIcon from '@mui/icons-material/Tune';
import ViewListIcon from '@mui/icons-material/ViewList';
import type { ContextHealth, ContextInfo } from '@kubus/shared';
import { useConnectContext, useContexts, useReconnectContext } from '../api/queries.js';
import { fuzzyMatch } from '../fuzzy.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { useClustersStore, type ContextSettings } from '../state/clusters.js';

const HEALTH_COLOR: Record<ContextHealth, 'success' | 'error' | 'warning' | 'disabled'> = {
  connected: 'success',
  error: 'error',
  connecting: 'warning',
  unknown: 'disabled',
};

const GRID_COLS = 3;

const PRESET_ICONS = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🏭', '🧪', '🛠️', '🚀', '🏠', '🌍', '☁️', '⚡', '📦', '🔒', '🐳', '🎯'];

function healthTitle(c: ContextInfo): string {
  if (c.health === 'connected') return c.kubernetesVersion ? `Connected · ${c.kubernetesVersion}` : 'Connected';
  if (c.health === 'connecting') return 'Checking connectivity';
  if (c.health === 'error') return c.healthMessage ?? 'Connection failed';
  return 'Not checked yet';
}

function selectedHealth(contexts: ContextInfo[] | undefined, selected: string[]): ContextHealth | undefined {
  if (!selected.length) return undefined;
  const byName = new Map((contexts ?? []).map((c) => [c.name, c.health]));
  const healths = selected.map((name) => byName.get(name) ?? 'unknown');
  if (healths.includes('error')) return 'error';
  if (healths.includes('connecting')) return 'connecting';
  if (healths.includes('unknown')) return 'unknown';
  return 'connected';
}

function groupOf(settings: Record<string, ContextSettings>, name: string): string | undefined {
  const g = settings[name]?.group?.trim();
  return g || undefined;
}

interface PickerSection {
  /** Group name; null renders without a header (flat list / search results). */
  label: string | null;
  contexts: ContextInfo[];
}

interface PickerData {
  sections: PickerSection[];
  /** All visible contexts in render order — the keyboard navigation space. */
  flat: ContextInfo[];
  /** Matched name characters per context, for search highlighting. */
  matches: Map<string, number[]>;
}

function buildPicker(
  contexts: ContextInfo[],
  settings: Record<string, ContextSettings>,
  order: string[],
  query: string,
): PickerData {
  const pos = new Map(order.map((n, i) => [n, i]));
  // Stable sort: contexts without a stored position keep kubeconfig order, after the arranged ones.
  const ordered = [...contexts].sort(
    (a, b) => (pos.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );

  const q = query.trim();
  if (q) {
    const scored: Array<{ c: ContextInfo; score: number; positions?: number[] }> = [];
    for (const c of ordered) {
      const name = fuzzyMatch(q, c.name);
      if (name) {
        scored.push({ c, score: name.score + 100, positions: name.positions });
        continue;
      }
      const group = groupOf(settings, c.name);
      const alt = (group ? fuzzyMatch(q, group) : null) ?? fuzzyMatch(q, c.server ?? c.cluster);
      if (alt) scored.push({ c, score: alt.score });
    }
    scored.sort((a, b) => b.score - a.score);
    const flat = scored.map((s) => s.c);
    return {
      sections: [{ label: null, contexts: flat }],
      flat,
      matches: new Map(scored.filter((s) => s.positions?.length).map((s) => [s.c.name, s.positions!])),
    };
  }

  const named = new Map<string, ContextInfo[]>();
  const ungrouped: ContextInfo[] = [];
  for (const c of ordered) {
    const g = groupOf(settings, c.name);
    if (g) {
      if (!named.has(g)) named.set(g, []);
      named.get(g)!.push(c);
    } else {
      ungrouped.push(c);
    }
  }
  if (!named.size) return { sections: [{ label: null, contexts: ungrouped }], flat: ungrouped, matches: new Map() };
  const sections: PickerSection[] = [...named.keys()].sort((a, b) => a.localeCompare(b)).map((label) => ({ label, contexts: named.get(label)! }));
  if (ungrouped.length) sections.push({ label: 'Ungrouped', contexts: ungrouped });
  return { sections, flat: sections.flatMap((s) => s.contexts), matches: new Map() };
}

/** Context name with fuzzy-matched characters emphasized. */
function MatchText({ text, positions }: { text: string; positions?: number[] }) {
  if (!positions?.length) return <>{text}</>;
  const hit = new Set(positions);
  return (
    <>
      {text.split('').map((ch, i) =>
        hit.has(i) ? (
          <Box key={i} component="span" sx={{ color: 'primary.main', fontWeight: 700 }}>
            {ch}
          </Box>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/** Per-context customization: emoji icon and picker group. */
function CustomizePopover({
  target,
  groups,
  onClose,
}: {
  target: { ctx: string; anchor: HTMLElement } | null;
  groups: string[];
  onClose: () => void;
}) {
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const setContextSetting = useClustersStore((s) => s.setContextSetting);
  const settings = target ? contextSettings[target.ctx] : undefined;
  return (
    <Popover
      open={!!target}
      anchorEl={target?.anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <Box sx={{ p: 1.5, width: 264 }}>
        <Typography variant="subtitle2" noWrap sx={{ mb: 1 }}>
          {target?.ctx}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Icon
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.25, my: 0.5 }}>
          <Tooltip title="No icon">
            <IconButton
              size="small"
              onClick={() => target && setContextSetting(target.ctx, { icon: undefined })}
              sx={{ borderRadius: 1, border: '1px solid', borderColor: settings?.icon ? 'transparent' : 'primary.main' }}
            >
              <BlockIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          {PRESET_ICONS.map((emoji) => (
            <IconButton
              key={emoji}
              size="small"
              onClick={() => target && setContextSetting(target.ctx, { icon: emoji })}
              sx={{ borderRadius: 1, fontSize: 15, border: '1px solid', borderColor: settings?.icon === emoji ? 'primary.main' : 'transparent' }}
            >
              {emoji}
            </IconButton>
          ))}
        </Box>
        <Typography variant="caption" color="text.secondary">
          Group
        </Typography>
        <Autocomplete
          size="small"
          freeSolo
          autoSelect
          options={groups}
          value={settings?.group ?? ''}
          onChange={(_e, value) => target && setContextSetting(target.ctx, { group: (value ?? '').trim() || undefined })}
          renderInput={(params) => <TextField {...params} placeholder="e.g. prod, team-a…" sx={{ mt: 0.5 }} />}
        />
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
          Drag entries or press Alt+↑↓ in the list to reorder.
        </Typography>
      </Box>
    </Popover>
  );
}

export function ClusterSwitcher() {
  const { data: contexts } = useContexts();
  const connect = useConnectContext();
  const reconnect = useReconnectContext();
  const selected = useClustersStore((s) => s.selected);
  const toggleContext = useClustersStore((s) => s.toggleContext);
  const setSelected = useClustersStore((s) => s.setSelected);
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const setContextSetting = useClustersStore((s) => s.setContextSetting);
  const contextOrder = useClustersStore((s) => s.contextOrder);
  const setContextOrder = useClustersStore((s) => s.setContextOrder);
  const layout = useClustersStore((s) => s.pickerLayout);
  const setPickerLayout = useClustersStore((s) => s.setPickerLayout);

  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [customize, setCustomize] = useState<{ ctx: string; anchor: HTMLElement } | null>(null);
  const [dragName, setDragName] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ name: string; before: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // On startup pick the persisted (or kubeconfig-current) selection; afterwards
  // keep the selection healthy on every context update: drop contexts gone from
  // the kubeconfig and re-establish sessions lost to a server restart or a live
  // kubeconfig change.
  const restored = useRef(false);
  const connecting = useRef(new Set<string>());
  useEffect(() => {
    if (!contexts) return;
    const byName = new Map(contexts.map((c) => [c.name, c]));
    let keep = selected.filter((name) => byName.has(name));
    if (keep.length !== selected.length) setSelected(keep);
    if (!restored.current) {
      restored.current = true;
      if (keep.length === 0) {
        const current = contexts.find((c) => c.current);
        if (current) setSelected((keep = [current.name]));
      }
    }
    for (const name of keep) {
      const info = byName.get(name);
      if (!info || info.active || connecting.current.has(name)) continue;
      connecting.current.add(name);
      connect.mutate({ ctx: name, connect: true }, { onSettled: () => connecting.current.delete(name) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contexts, selected]);

  const { sections, flat, matches } = useMemo(
    () => buildPicker(contexts ?? [], contextSettings, contextOrder, query),
    [contexts, contextSettings, contextOrder, query],
  );
  // Flat index of each section's first context, for keyboard navigation.
  const sectionStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const s of sections) {
      starts.push(acc);
      acc += s.contexts.length;
    }
    return starts;
  }, [sections]);
  const groupNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of contexts ?? []) {
      const g = groupOf(contextSettings, c.name);
      if (g) names.add(g);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [contexts, contextSettings]);

  const searching = query.trim().length > 0;
  const canReorder = !searching;

  useEffect(() => {
    if (anchor) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [anchor]);
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
  }, [flat.length]);
  // Keep the keyboard-active entry in view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const closePicker = () => {
    setCustomize(null);
    setAnchor(null);
  };

  /** Make `names` the selection, connecting/disconnecting only the deltas. */
  const applySelection = (names: string[]) => {
    const next = new Set(names);
    const cur = new Set(selected);
    for (const name of names) if (!cur.has(name)) connect.mutate({ ctx: name, connect: true });
    for (const name of selected) if (!next.has(name)) connect.mutate({ ctx: name, connect: false });
    setSelected(names);
  };

  const handleToggle = (name: string) => {
    const isSelected = selected.includes(name);
    toggleContext(name);
    connect.mutate({ ctx: name, connect: !isSelected });
  };

  // Row click switches to that cluster alone; the checkbox handles multi-select.
  const handleSelectOnly = (name: string) => {
    applySelection([name]);
    closePicker();
  };

  const selectAllVisible = () => applySelection([...new Set([...selected, ...flat.map((c) => c.name)])]);
  const clearAll = () => applySelection([]);
  const toggleSection = (section: PickerSection) => {
    const names = section.contexts.map((c) => c.name);
    const all = names.every((n) => selected.includes(n));
    applySelection(all ? selected.filter((n) => !names.includes(n)) : [...new Set([...selected, ...names])]);
  };

  /**
   * Move the keyboard-active context one step. Crossing a section boundary
   * re-assigns its group (positions already read correctly); within a section
   * it swaps with its neighbor. Either way the full visible order is persisted
   * so rendering and stored order stay in sync.
   */
  const moveActive = (delta: -1 | 1) => {
    const item = flat[activeIndex];
    const neighbor = flat[activeIndex + delta];
    if (!item || !neighbor) return;
    const names = flat.map((c) => c.name);
    const itemGroup = groupOf(contextSettings, item.name);
    const neighborGroup = groupOf(contextSettings, neighbor.name);
    if (itemGroup !== neighborGroup) {
      setContextSetting(item.name, { group: neighborGroup });
      setContextOrder(names);
    } else {
      [names[activeIndex], names[activeIndex + delta]] = [names[activeIndex + delta]!, names[activeIndex]!];
      setContextOrder(names);
      setActiveIndex(activeIndex + delta);
    }
  };

  /** Drop `drag` before/after `target`, adopting the target's group. */
  const handleDrop = (drag: string, target: string, before: boolean) => {
    setDragName(null);
    setDropHint(null);
    if (drag === target) return;
    const names = flat.map((c) => c.name).filter((n) => n !== drag);
    const ti = names.indexOf(target);
    if (ti === -1) return;
    names.splice(before ? ti : ti + 1, 0, drag);
    const targetGroup = groupOf(contextSettings, target);
    if (groupOf(contextSettings, drag) !== targetGroup) setContextSetting(drag, { group: targetGroup });
    setContextOrder(names);
  };

  /**
   * Vertical arrow movement in the grid: each section renders its own
   * GRID_COLS-wide grid, so map to the card visually above/below via
   * section-local rows and columns instead of a global ±GRID_COLS.
   */
  const gridMove = (i: number, dir: 1 | -1): number => {
    const si = sections.findIndex((s, n) => i >= sectionStarts[n]! && i < sectionStarts[n]! + s.contexts.length);
    if (si === -1) return i;
    const start = sectionStarts[si]!;
    const len = sections[si]!.contexts.length;
    const local = i - start;
    const col = local % GRID_COLS;
    if (dir === 1) {
      const below = local + GRID_COLS;
      if (below < len) return start + below;
      // A partial last row exists below: snap to its last card.
      if (Math.floor(local / GRID_COLS) < Math.floor((len - 1) / GRID_COLS)) return start + len - 1;
      // On the section's last row: continue into the next section's first row.
      if (si + 1 < sections.length) return sectionStarts[si + 1]! + Math.min(col, sections[si + 1]!.contexts.length - 1);
      return i;
    }
    const above = local - GRID_COLS;
    if (above >= 0) return start + above;
    if (si > 0) {
      // Land on the previous section's last row, same column.
      const prevLen = sections[si - 1]!.contexts.length;
      const lastRow = Math.floor((prevLen - 1) / GRID_COLS) * GRID_COLS;
      return sectionStarts[si - 1]! + Math.min(lastRow + col, prevLen - 1);
    }
    return i;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const fromSearch = e.target === searchRef.current;
    if (e.key === 'Escape') {
      if (query) {
        e.preventDefault();
        e.stopPropagation();
        setQuery('');
      }
      return;
    }
    if (e.altKey && canReorder && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      moveActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : (-1 as const);
      if (layout === 'grid') setActiveIndex((i) => gridMove(i, dir));
      else setActiveIndex((i) => Math.max(0, Math.min(i + dir, flat.length - 1)));
      return;
    }
    if (layout === 'grid' && query === '' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      setActiveIndex((i) => Math.max(0, Math.min(i + delta, flat.length - 1)));
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const delta = e.key === 'PageDown' ? 8 : -8;
      setActiveIndex((i) => Math.max(0, Math.min(i + delta, flat.length - 1)));
      return;
    }
    if (e.key === 'Enter' && fromSearch) {
      e.preventDefault();
      const item = flat[activeIndex];
      if (!item) return;
      if (mod || e.shiftKey) handleToggle(item.name);
      else handleSelectOnly(item.name);
      return;
    }
    if (e.key === ' ' && fromSearch && query === '') {
      e.preventDefault();
      const item = flat[activeIndex];
      if (item) handleToggle(item.name);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a' && fromSearch && query === '') {
      e.preventDefault();
      selectAllVisible();
    }
  };

  const only = selected.length === 1 ? selected[0] : undefined;
  const label = selected.length === 0 ? 'Select clusters' : (only ?? `${selected.length} clusters`);
  const onlyProtected = only ? !!contextSettings[only]?.protected : false;
  const onlyIcon = only ? contextSettings[only]?.icon : undefined;
  const selectedConnectivity = selectedHealth(contexts, selected);

  const renderRow = (c: ContextInfo, idx: number) => {
    const isProtected = !!contextSettings[c.name]?.protected;
    const icon = contextSettings[c.name]?.icon;
    const isReconnecting = reconnect.isPending && reconnect.variables === c.name;
    const busy = (connect.isPending && connect.variables?.ctx === c.name) || isReconnecting;
    const isDropTarget = !!dropHint && dropHint.name === c.name && dragName !== c.name;
    return (
      <ListItemButton
        key={c.name}
        data-idx={idx}
        dense
        selected={idx === activeIndex}
        onClick={() => handleSelectOnly(c.name)}
        onMouseEnter={() => setActiveIndex(idx)}
        draggable={canReorder}
        onDragStart={(e) => {
          setDragName(c.name);
          e.dataTransfer.setData('text/plain', c.name);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          setDragName(null);
          setDropHint(null);
        }}
        onDragOver={(e) => {
          if (!dragName || dragName === c.name) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2;
          setDropHint((h) => (h && h.name === c.name && h.before === before ? h : { name: c.name, before }));
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!dragName) return;
          const r = e.currentTarget.getBoundingClientRect();
          handleDrop(dragName, c.name, e.clientY < r.top + r.height / 2);
        }}
        sx={{
          borderRadius: 1,
          px: 1,
          ...(isDropTarget && {
            [dropHint.before ? 'borderTop' : 'borderBottom']: '2px solid',
            borderColor: 'primary.main',
          }),
          '& .ctx-drag': { opacity: 0 },
          '&:hover .ctx-drag': { opacity: canReorder ? 0.5 : 0 },
        }}
      >
        <DragIndicatorIcon className="ctx-drag" sx={{ fontSize: 16, mr: 0.25, cursor: 'grab' }} />
        <Checkbox
          checked={selected.includes(c.name)}
          size="small"
          sx={{ p: 0.5, mr: 1 }}
          slotProps={{ input: { 'aria-label': `Select ${c.name}` } }}
          onClick={(e) => {
            e.stopPropagation();
            handleToggle(c.name);
          }}
        />
        <ListItemIcon sx={{ minWidth: 28 }}>
          {busy ? (
            <CircularProgress size={12} />
          ) : (
            <Tooltip title={healthTitle(c)}>
              <CircleIcon color={HEALTH_COLOR[c.health]} sx={{ fontSize: 12 }} />
            </Tooltip>
          )}
        </ListItemIcon>
        <ListItemText
          primary={
            <>
              {icon && (
                <Box component="span" sx={{ mr: 0.75 }}>
                  {icon}
                </Box>
              )}
              <MatchText text={c.name} positions={matches.get(c.name)} />
            </>
          }
          secondary={
            <Typography component="span" variant="caption" color="text.secondary">
              {c.server ?? c.cluster}
              {c.kubernetesVersion ? ` · ${c.kubernetesVersion}` : ''}
            </Typography>
          }
        />
        {c.active && (
          <Tooltip title="Reconnect: rebuild this session with fresh credentials, discovery, and watches">
            <IconButton
              aria-label={`Reconnect ${c.name}`}
              size="small"
              disabled={isReconnecting}
              onClick={(e) => {
                e.stopPropagation();
                reconnect.mutate(c.name);
              }}
            >
              <RestartAltIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={isProtected ? 'Protected: destructive actions require typed confirmation' : 'Mark as protected (e.g. production)'}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setContextSetting(c.name, { protected: !isProtected });
            }}
          >
            {isProtected ? <ShieldIcon color="warning" sx={{ fontSize: 16 }} /> : <ShieldOutlinedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Customize icon & group">
          <IconButton
            aria-label={`Customize ${c.name}`}
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setCustomize({ ctx: c.name, anchor: e.currentTarget });
            }}
          >
            <TuneIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </ListItemButton>
    );
  };

  const renderCard = (c: ContextInfo, idx: number) => {
    const isProtected = !!contextSettings[c.name]?.protected;
    const icon = contextSettings[c.name]?.icon;
    const isReconnecting = reconnect.isPending && reconnect.variables === c.name;
    const busy = (connect.isPending && connect.variables?.ctx === c.name) || isReconnecting;
    const protectButton = (
      <Tooltip title={isProtected ? 'Protected: destructive actions require typed confirmation' : 'Mark as protected (e.g. production)'}>
        <IconButton
          size="small"
          sx={{ p: 0.25 }}
          onClick={(e) => {
            e.stopPropagation();
            setContextSetting(c.name, { protected: !isProtected });
          }}
        >
          {isProtected ? <ShieldIcon color="warning" sx={{ fontSize: 14 }} /> : <ShieldOutlinedIcon sx={{ fontSize: 14 }} />}
        </IconButton>
      </Tooltip>
    );
    return (
      <Box
        key={c.name}
        data-idx={idx}
        onClick={() => handleSelectOnly(c.name)}
        onMouseEnter={() => setActiveIndex(idx)}
        sx={{
          border: '1px solid',
          borderColor: idx === activeIndex ? 'primary.main' : 'divider',
          bgcolor: selected.includes(c.name) ? 'action.selected' : undefined,
          borderRadius: 1,
          p: 1,
          cursor: 'pointer',
          minWidth: 0,
          '& .ctx-card-actions': { visibility: 'hidden' },
          '&:hover .ctx-card-actions': { visibility: 'visible' },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          {busy ? (
            <CircularProgress size={10} />
          ) : (
            <Tooltip title={healthTitle(c)}>
              <CircleIcon color={HEALTH_COLOR[c.health]} sx={{ fontSize: 10 }} />
            </Tooltip>
          )}
          {icon && <Box component="span">{icon}</Box>}
          <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            <MatchText text={c.name} positions={matches.get(c.name)} />
          </Typography>
          <Checkbox
            checked={selected.includes(c.name)}
            size="small"
            sx={{ p: 0 }}
            slotProps={{ input: { 'aria-label': `Select ${c.name}` } }}
            onClick={(e) => {
              e.stopPropagation();
              handleToggle(c.name);
            }}
          />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, mt: 0.5, minHeight: 22 }}>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            {c.server ?? c.cluster}
            {c.kubernetesVersion ? ` · ${c.kubernetesVersion}` : ''}
          </Typography>
          <Box className="ctx-card-actions" sx={{ display: 'flex', gap: 0.25 }}>
            {c.active && (
              <Tooltip title="Reconnect: rebuild this session with fresh credentials, discovery, and watches">
                <IconButton
                  aria-label={`Reconnect ${c.name}`}
                  size="small"
                  sx={{ p: 0.25 }}
                  disabled={isReconnecting}
                  onClick={(e) => {
                    e.stopPropagation();
                    reconnect.mutate(c.name);
                  }}
                >
                  <RestartAltIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            )}
            {!isProtected && protectButton}
            <Tooltip title="Customize icon & group">
              <IconButton
                aria-label={`Customize ${c.name}`}
                size="small"
                sx={{ p: 0.25 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomize({ ctx: c.name, anchor: e.currentTarget });
                }}
              >
                <TuneIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
          {isProtected && protectButton}
        </Box>
      </Box>
    );
  };

  const renderHeader = (section: PickerSection) => {
    const names = section.contexts.map((c) => c.name);
    const selCount = names.filter((n) => selected.includes(n)).length;
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1, pt: 0.75, pb: 0.25 }}>
        <Tooltip title={selCount === names.length ? `Deselect all in ${section.label}` : `Select all in ${section.label}`}>
          <Checkbox
            size="small"
            sx={{ p: 0.25 }}
            slotProps={{ input: { 'aria-label': `Select group ${section.label}` } }}
            checked={selCount === names.length}
            indeterminate={selCount > 0 && selCount < names.length}
            onChange={() => toggleSection(section)}
          />
        </Tooltip>
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          {section.label}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {selCount ? `${selCount}/${names.length}` : names.length}
        </Typography>
      </Box>
    );
  };

  return (
    <>
      <Button variant="outlined" color="inherit" endIcon={<KeyboardArrowDownIcon />} onClick={(e) => setAnchor(e.currentTarget)}>
        {selectedConnectivity && (
          <Tooltip title={selected.length === 1 ? `Connectivity: ${selectedConnectivity}` : `Selected clusters: ${selectedConnectivity}`}>
            <CircleIcon color={HEALTH_COLOR[selectedConnectivity]} sx={{ fontSize: 10, mr: 1 }} />
          </Tooltip>
        )}
        {onlyIcon && (
          <Box component="span" sx={{ mr: 0.75 }}>
            {onlyIcon}
          </Box>
        )}
        {label}
        {onlyProtected && <ShieldIcon sx={{ fontSize: 14, ml: 0.75, opacity: 0.7 }} />}
      </Button>
      <Popover
        anchorEl={anchor}
        open={!!anchor}
        onClose={closePicker}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { width: layout === 'grid' ? 640 : 480, maxWidth: 'calc(100vw - 32px)' } },
          transition: { onEntered: () => searchRef.current?.focus() },
        }}
      >
        <Box onKeyDown={onKeyDown}>
          <Box sx={{ px: 1.5, pt: 1.25 }}>
            <TextField
              fullWidth
              size="small"
              autoFocus
              inputRef={searchRef}
              placeholder="Search contexts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.5, py: 0.5 }}>
            <Button size="small" onClick={selectAllVisible} disabled={!flat.length}>
              {searching ? `Select matches (${flat.length})` : 'Select all'}
            </Button>
            <Button size="small" onClick={clearAll} disabled={!selected.length}>
              Clear
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
              {selected.length}/{(contexts ?? []).length} selected
            </Typography>
            <Tooltip title="List layout">
              <IconButton size="small" aria-label="List layout" color={layout === 'list' ? 'primary' : 'default'} onClick={() => setPickerLayout('list')}>
                <ViewListIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Grid layout">
              <IconButton size="small" aria-label="Grid layout" color={layout === 'grid' ? 'primary' : 'default'} onClick={() => setPickerLayout('grid')}>
                <GridViewIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Divider />
          <Box ref={listRef} sx={{ maxHeight: 440, overflowY: 'auto', p: 0.5 }}>
            {sections.map((section, si) => (
              <Box key={`${si}:${section.label ?? ''}`}>
                {section.label && renderHeader(section)}
                {layout === 'grid' ? (
                  <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gap: 0.75, p: 0.5 }}>
                    {section.contexts.map((c, i) => renderCard(c, sectionStarts[si]! + i))}
                  </Box>
                ) : (
                  section.contexts.map((c, i) => renderRow(c, sectionStarts[si]! + i))
                )}
              </Box>
            ))}
            {(contexts ?? []).length === 0 && (
              <Box sx={{ px: 2, py: 1.5, maxWidth: 320 }}>
                <Typography variant="body2" color="text.secondary">
                  No contexts found in kubeconfig. Check <Chip label="~/.kube/config" size="small" /> or set KUBECONFIG.
                </Typography>
              </Box>
            )}
            {(contexts ?? []).length > 0 && flat.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5 }}>
                No contexts match “{query.trim()}”.
              </Typography>
            )}
          </Box>
          <Divider />
          <Box sx={{ px: 1.5, py: 0.75 }}>
            <Typography variant="caption" color="text.secondary">
              ↑↓ navigate · ↵ switch · Space or {HOTKEY_MOD_LABEL}↵ toggle · {HOTKEY_MOD_LABEL}A select all
              {canReorder ? ' · Alt+↑↓ move' : ''}
            </Typography>
          </Box>
        </Box>
      </Popover>
      <CustomizePopover target={customize} groups={groupNames} onClose={() => setCustomize(null)} />
    </>
  );
}
