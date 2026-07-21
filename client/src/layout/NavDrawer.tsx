import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { layout } from '../theme.js';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import DifferenceOutlinedIcon from '@mui/icons-material/DifferenceOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import QueryStatsOutlinedIcon from '@mui/icons-material/QueryStatsOutlined';
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined';
import GppMaybeOutlinedIcon from '@mui/icons-material/GppMaybeOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { BUILTIN_NAV_GROUPS, groupToPath, gvkForResource, gvkLabel, pluralLabel, type FavoriteItem, type ResourceKindInfo, type SavedView } from '@kubus/shared';
import { useApiResourcesForContexts } from '../api/queries.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { useClustersStore } from '../state/clusters.js';
import { useNavigationStore } from '../state/navigation.js';
import { useTabsStore } from '../state/tabs.js';
import { applySavedViewGridState } from '../state/saved-view.js';
import { GROUP_ICONS } from './tab-meta.js';
import { TruncationTooltip } from '../components/truncation.js';

const WIDTH = layout.navDrawerWidth;
// Indent of group items so they line up under the group label (button pl 16px + icon 26px).
const ITEM_INDENT = '42px';
// Two deeper steps for the Custom Resources tree (domain → API group → kind).
const SUB_INDENT = '54px';
const KIND_INDENT = '66px';
const FAVORITE_DRAG_TYPE = 'application/x-kubus-favorite';
const CUSTOM_GROUP_PREFIX = 'custom:';
const CRD_LIST_PATH = '/r/apiextensions.k8s.io/v1/customresourcedefinitions';


/**
 * The first nine navigable favorites, in sidebar order, get Cmd/Ctrl+1–9.
 * Category favorites expand in place rather than navigating, so they are
 * skipped without consuming a slot.
 */
function hotkeyFavorites(favorites: FavoriteItem[]): FavoriteItem[] {
  return favorites.filter((fav) => !!fav.path).slice(0, 9);
}

/**
 * Browser-style modifiers on nav links: Ctrl/Cmd+click opens a background
 * page tab (+Shift focuses it), middle-click opens a background tab.
 * Plain clicks keep navigating the active tab via NavLink.
 */
function useOpenInNewTab(to: string, pendingSavedView?: SavedView['grid']) {
  const openTab = useTabsStore((s) => s.openTab);
  const navigate = useNavigate();
  const open = (e: React.MouseEvent, foreground: boolean) => {
    e.preventDefault();
    if (foreground && pendingSavedView) applySavedViewGridState(to, pendingSavedView);
    openTab(to, { activate: foreground, afterActive: true, pendingSavedView: foreground ? undefined : pendingSavedView });
    if (foreground) void navigate(to);
  };
  return {
    onClick: (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) open(e, e.shiftKey);
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) open(e, false);
    },
  };
}

function kindPath(group: string, version: string, plural: string): string {
  return `/r/${groupToPath(group)}/${version}/${plural}`;
}

type NavKind = { group: string; version: string; plural: string; kind: string; label: string };

function kindFavorite(k: NavKind): FavoriteItem {
  return {
    id: `kind:${k.group}/${k.version}/${k.plural}`,
    title: k.label,
    subtitle: gvkLabel(k),
    path: kindPath(k.group, k.version, k.plural),
  };
}

/** Resolve old persisted kind favorites to a full GVK once discovery is available. */
function favoriteGvk(favorite: FavoriteItem, resources: ResourceKindInfo[]): string | undefined {
  if (!favorite.id.startsWith('kind:')) return favorite.subtitle;
  const [group, version, plural] = favorite.id.slice('kind:'.length).split('/');
  if (group === undefined || !version || !plural) return favorite.subtitle;
  const discovered = resources.find((r) => r.group === group && r.version === version && r.plural === plural);
  const resource = discovered ?? gvkForResource(group, version, plural);
  return resource ? gvkLabel(resource) : favorite.subtitle;
}

// Star toggle revealed on row hover; filled vs outlined shows favorite state.
function FavStar({ active, onToggle, label }: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <Tooltip title={active ? 'Remove favorite' : 'Add favorite'}>
      <IconButton
        aria-label={label}
        size="small"
        className="fav-star"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        sx={{
          opacity: 0,
          color: 'text.secondary',
          transition: 'opacity 120ms ease',
          '& svg': { fontSize: 16 },
          '&:focus-visible': { opacity: 1 },
        }}
      >
        {active ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

// The topology impl chunk (@xyflow/react + elkjs) is heavy; warm it when the
// user shows intent instead of unconditionally at idle for every session.
const preloadTopology = () => void import('../components/TopologyGraphImpl.js');

const VERSION_RE = /^v(\d+)(?:(alpha|beta)(\d+))?$/;

function versionScore(version: string): [number, number, number] {
  const match = VERSION_RE.exec(version);
  if (!match) return [0, 0, 0];
  const stability = match[2] === 'alpha' ? 1 : match[2] === 'beta' ? 2 : 3;
  return [stability, Number(match[1]), Number(match[3] ?? 0)];
}

function preferVersion(candidate: ResourceKindInfo, current: ResourceKindInfo): ResourceKindInfo {
  const a = versionScore(candidate.version);
  const b = versionScore(current.version);
  if (a[0] !== b[0]) return a[0] > b[0] ? candidate : current;
  if (a[1] !== b[1]) return a[1] > b[1] ? candidate : current;
  if (a[2] !== b[2]) return a[2] > b[2] ? candidate : current;
  return candidate.version.localeCompare(current.version) > 0 ? candidate : current;
}

function dedupeCustomNavKinds(kinds: ResourceKindInfo[]): ResourceKindInfo[] {
  const byKind = new Map<string, ResourceKindInfo>();
  for (const kind of kinds) {
    const key = `${kind.group}/${kind.plural}/${kind.kind}`;
    const current = byKind.get(key);
    byKind.set(key, current ? preferVersion(kind, current) : kind);
  }
  return [...byKind.values()];
}

interface CustomSubgroup {
  /** Full API group, e.g. `appstore.eda.nokia.com`. */
  group: string;
  /** Group with the shared domain stripped, e.g. `appstore.eda`. */
  label: string;
  kinds: ResourceKindInfo[];
}

/**
 * One top-level entry under Custom Resources: a lone API group shown by its
 * full name, or a domain (last two dot-labels, e.g. `nokia.com`) folding the
 * groups that share it. A group named exactly like the domain contributes its
 * kinds directly to the domain entry rather than an empty-labelled subgroup.
 */
interface CustomNavNode {
  label: string;
  kinds: ResourceKindInfo[];
  subgroups: CustomSubgroup[];
}

function buildCustomNav(customKinds: Array<[string, ResourceKindInfo[]]>): CustomNavNode[] {
  const byDomain = new Map<string, Array<{ group: string; kinds: ResourceKindInfo[] }>>();
  for (const [group, kinds] of customKinds) {
    const domain = group.split('.').slice(-2).join('.');
    const list = byDomain.get(domain) ?? [];
    list.push({ group, kinds });
    byDomain.set(domain, list);
  }
  const nodes: CustomNavNode[] = [];
  for (const [domain, groups] of byDomain) {
    if (groups.length === 1) {
      nodes.push({ label: groups[0]!.group, kinds: groups[0]!.kinds, subgroups: [] });
      continue;
    }
    const own = groups.find((g) => g.group === domain);
    const subgroups = groups
      .filter((g) => g.group !== domain)
      .map((g) => ({ group: g.group, label: g.group.slice(0, -(domain.length + 1)), kinds: g.kinds }))
      .sort((a, b) => a.label.localeCompare(b.label));
    nodes.push({ label: domain, kinds: own?.kinds ?? [], subgroups });
  }
  return nodes.sort((a, b) => a.label.localeCompare(b.label));
}

function NavEntry({
  to,
  label,
  subtitle,
  icon,
  favorite,
  favoriteAction,
  hotkey,
  onIntent,
  indent,
}: {
  to: string;
  label: string;
  subtitle?: string;
  icon?: React.ReactElement;
  favorite?: FavoriteItem;
  favoriteAction?: ReactNode;
  /** Shortcut hint (e.g. ⌘1) shown at rest; hover swaps it for the row actions. */
  hotkey?: string;
  /** Fired on hover/focus — used to preload the target's heavy chunks. */
  onIntent?: () => void;
  /** Left padding override for entries nested below the default group level. */
  indent?: string;
}) {
  const location = useLocation();
  const active = location.pathname === to;
  const isFav = useNavigationStore((s) => (favorite ? s.favorites.some((x) => x.id === favorite.id) : false));
  const addFavorite = useNavigationStore((s) => s.addFavorite);
  const removeFavorite = useNavigationStore((s) => s.removeFavorite);
  const newTabHandlers = useOpenInNewTab(to);
  const button = (
    <ListItemButton
      component={NavLink}
      to={to}
      dense
      selected={active}
      onMouseEnter={onIntent}
      onFocus={onIntent}
      {...newTabHandlers}
      sx={{ pl: icon ? 1.5 : (indent ?? ITEM_INDENT), py: subtitle ? 0.25 : 0.375, pr: favorite ? (favoriteAction ? 7 : 4) : undefined }}
    >
      {icon && (
        <ListItemIcon sx={{ minWidth: 26, color: 'text.secondary', '& svg': { fontSize: 17 } }}>{icon}</ListItemIcon>
      )}
      <TruncationTooltip text={label} measureSelector=".MuiListItemText-primary">
        <ListItemText
          primary={label}
          secondary={subtitle}
          sx={{ my: subtitle ? 0.25 : undefined }}
          slotProps={{
            primary: { variant: 'body2', noWrap: true, sx: subtitle ? { lineHeight: 1.25 } : undefined },
            secondary: { noWrap: true, title: subtitle, sx: { fontSize: 10.5, fontStyle: 'italic', lineHeight: 1.1 } },
          }}
        />
      </TruncationTooltip>
    </ListItemButton>
  );
  if (!favorite) return button;
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, position: 'relative' }}>
          {favoriteAction}
          <FavStar
            active={isFav}
            label={`${isFav ? 'Remove' : 'Add'} favorite ${label}`}
            onToggle={() => (isFav ? removeFavorite(favorite.id) : addFavorite(favorite))}
          />
          {hotkey && (
            <Typography
              className="fav-hotkey"
              variant="caption"
              aria-hidden
              sx={{
                position: 'absolute',
                right: 6,
                color: 'text.disabled',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              {hotkey}
            </Typography>
          )}
        </Box>
      }
      sx={{ '& .MuiListItemSecondaryAction-root': { right: 4 }, '&:hover .fav-star': { opacity: 1 }, '&:hover .fav-hotkey': { opacity: 0 } }}
    >
      {button}
    </ListItem>
  );
}

function SavedViewEntry({ view, onDelete }: { view: SavedView; onDelete: (id: string) => void }) {
  const location = useLocation();
  const active = `${location.pathname}${location.search}` === view.path;
  const newTabHandlers = useOpenInNewTab(view.path, view.grid);
  // Views saved with a grid snapshot restore the whole table — namespaces,
  // sort, column visibility and widths — not just the query in the path.
  // Older views without one restore the query only.
  const applyGridState = () => {
    const grid = view.grid;
    if (!grid) return;
    applySavedViewGridState(view.path, grid);
  };
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <Tooltip title="Delete saved view">
          <IconButton
            aria-label={`Delete saved view ${view.title}`}
            size="small"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(view.id);
            }}
            sx={{ '& svg': { fontSize: 17 } }}
          >
            <DeleteOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      }
      sx={{ '& .MuiListItemSecondaryAction-root': { right: 4 } }}
    >
      <ListItemButton
        component={NavLink}
        to={view.path}
        dense
        selected={active}
        onClick={(e) => {
          if (!e.ctrlKey && !e.metaKey) applyGridState();
          newTabHandlers.onClick(e);
        }}
        onAuxClick={(e) => {
          newTabHandlers.onAuxClick(e);
        }}
        sx={{ pl: ITEM_INDENT, py: 0.375, pr: 4.5 }}
      >
        <ListItemText primary={view.title} slotProps={{ primary: { variant: 'body2', noWrap: true } }} />
      </ListItemButton>
    </ListItem>
  );
}

function GroupHeader({
  title,
  icon,
  open,
  onClick,
  favorite,
  favoriteAction,
}: {
  title: string;
  icon?: React.ReactElement;
  open: boolean;
  onClick: () => void;
  favorite?: { active: boolean; onToggle: () => void };
  favoriteAction?: ReactNode;
}) {
  return (
    <ListItem
      disablePadding
      secondaryAction={
        favorite || favoriteAction ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
            {favoriteAction}
            {favorite && (
              <FavStar
                active={favorite.active}
                onToggle={favorite.onToggle}
                label={`${favorite.active ? 'Remove' : 'Add'} favorite category ${title}`}
              />
            )}
          </Box>
        ) : undefined
      }
      sx={{ mt: 1.25, '&:hover .fav-star': { opacity: 1 }, '& .MuiListItemSecondaryAction-root': { right: 4 } }}
    >
      <ListItemButton
        dense
        onClick={onClick}
        sx={{ py: 0.25, color: 'text.secondary', pr: favoriteAction ? 8 : favorite ? 5.5 : undefined }}
      >
        <ListItemIcon sx={{ minWidth: 26, color: 'inherit', '& svg': { fontSize: 16 } }}>{icon}</ListItemIcon>
        <ListItemText
          primary={title}
          slotProps={{ primary: { variant: 'body2', sx: { fontWeight: 600, fontSize: 12.5, color: 'text.secondary' } } }}
        />
        <ExpandMoreIcon
          sx={{ fontSize: 16, opacity: 0.6, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms ease' }}
        />
      </ListItemButton>
    </ListItem>
  );
}

/** Collapsible domain / API-group header inside the Custom Resources tree. */
function CustomGroupHeader({
  label,
  title,
  count,
  indent,
  open,
  active,
  onClick,
}: {
  label: string;
  /** Hover hint; defaults to the label (subgroups pass their full API group). */
  title?: string;
  count?: number;
  indent: string;
  open: boolean;
  /** The current page lives inside this branch — color it as the active trail. */
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <ListItemButton
      dense
      aria-expanded={open}
      onClick={onClick}
      sx={{ pl: indent, pr: 1.5, py: 0.375, mt: 0.5, color: active ? 'primary.main' : open ? 'text.primary' : 'text.secondary' }}
    >
      {/* Same body2 size as the kind rows below — hierarchy comes from the
          600 weight, indent and rail, not from switching to a smaller bold
          caption face that reads as foreign next to the rest of the nav.
          Subgroups tooltip their full API group even untruncated (`always`),
          since the visible label is only the domain-stripped suffix. */}
      <TruncationTooltip
        text={title ?? label}
        always={!!title && title !== label}
        measureSelector=".MuiListItemText-primary"
      >
        <ListItemText
          primary={label}
          slotProps={{ primary: { variant: 'body2', noWrap: true, sx: { fontWeight: 600, lineHeight: 1.4 } } }}
        />
      </TruncationTooltip>
      {count !== undefined && (
        <Typography variant="caption" aria-hidden sx={{ ml: 0.5, color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}>
          {count}
        </Typography>
      )}
      <ExpandMoreIcon
        sx={{ ml: 0.5, fontSize: 15, opacity: 0.6, flexShrink: 0, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms ease' }}
      />
    </ListItemButton>
  );
}

/**
 * Children of an expanded Custom Resources level: a faint panel tint plus,
 * on the first level only, an indent guide rail aligned under the parent
 * label — a second rail per nesting level reads as clutter. The rail takes
 * the accent color while the branch contains the current page.
 */
function TreeChildren({ railLeft, active, children }: { railLeft?: string; active?: boolean; children: ReactNode }) {
  return (
    <Box
      sx={{
        position: 'relative',
        bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.02)'),
        ...(railLeft && {
          '&::before': {
            content: '""',
            position: 'absolute',
            left: railLeft,
            top: 3,
            bottom: 3,
            width: '2px',
            borderRadius: 1,
            bgcolor: active ? 'primary.main' : 'divider',
            opacity: active ? 0.55 : 1,
            pointerEvents: 'none',
            zIndex: 1,
          },
        }),
      }}
    >
      {children}
    </Box>
  );
}

type FavoriteDropTarget = { id: string; position: 'before' | 'after' };

function favoriteDropPosition(e: DragEvent<HTMLElement>): FavoriteDropTarget['position'] {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function FavoriteDragHandle({
  favorite,
  onDragStart,
  onDragEnd,
}: {
  favorite: FavoriteItem;
  onDragStart: (favorite: FavoriteItem, e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <Tooltip title="Drag to reorder">
      <IconButton
        aria-label={`Reorder favorite ${favorite.title}`}
        size="small"
        draggable
        className="favorite-drag-handle"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragStart={(e) => onDragStart(favorite, e)}
        onDragEnd={onDragEnd}
        sx={{
          cursor: 'grab',
          color: 'text.secondary',
          opacity: 0,
          transition: 'opacity 120ms ease',
          '&:active': { cursor: 'grabbing' },
          '& svg': { fontSize: 17 },
          '&:focus-visible': { opacity: 1 },
        }}
      >
        <DragIndicatorIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function FavoriteDragShell({
  favorite,
  draggingId,
  dropTarget,
  children,
  onDropTarget,
  onDropFavorite,
  onClearDropTarget,
}: {
  favorite: FavoriteItem;
  draggingId: string | null;
  dropTarget: FavoriteDropTarget | null;
  children: ReactNode;
  onDropTarget: (target: FavoriteDropTarget) => void;
  onDropFavorite: (target: FavoriteDropTarget) => void;
  onClearDropTarget: (id: string) => void;
}) {
  const activeDrop = dropTarget?.id === favorite.id ? dropTarget.position : undefined;
  const canDrop = !!draggingId && draggingId !== favorite.id;
  return (
    <Box
      sx={{
        position: 'relative',
        opacity: draggingId === favorite.id ? 0.45 : 1,
        '&:hover .favorite-drag-handle': { opacity: 1 },
      }}
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDropTarget({ id: favorite.id, position: favoriteDropPosition(e) });
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        onClearDropTarget(favorite.id);
      }}
      onDrop={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        onDropFavorite({ id: favorite.id, position: favoriteDropPosition(e) });
      }}
    >
      {activeDrop === 'before' && <Box sx={{ position: 'absolute', top: 0, left: 10, right: 10, height: 2, bgcolor: 'primary.main', zIndex: 2 }} />}
      {children}
      {activeDrop === 'after' && <Box sx={{ position: 'absolute', bottom: 0, left: 10, right: 10, height: 2, bgcolor: 'primary.main', zIndex: 2 }} />}
    </Box>
  );
}

interface NavDrawerProps {
  /** Render as a temporary overlay (narrow viewports) instead of a pinned rail. */
  overlay: boolean;
  /** Pinned rail collapsed to zero width; content stays mounted for hotkeys. */
  hidden: boolean;
  open: boolean;
  onClose: () => void;
}

export const NavDrawer = memo(function NavDrawer({ overlay, hidden, open, onClose }: NavDrawerProps) {
  const selected = useClustersStore((s) => s.selected);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const favorites = useNavigationStore((s) => s.favorites);
  const savedViews = useNavigationStore((s) => s.savedViews);
  const removeSavedView = useNavigationStore((s) => s.removeSavedView);
  const addFavorite = useNavigationStore((s) => s.addFavorite);
  const removeFavorite = useNavigationStore((s) => s.removeFavorite);
  const moveFavorite = useNavigationStore((s) => s.moveFavorite);
  // Favorited categories ('fav:<title>') start collapsed so they show as a
  // single entry rather than flooding Favorites with every kind.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const set = new Set<string>(['Custom Resources']);
    for (const fav of useNavigationStore.getState().favorites) {
      if (fav.id.startsWith('category:')) set.add(`fav:${fav.title}`);
    }
    return set;
  });
  const [filter, setFilter] = useState('');
  const [draggingFavoriteId, setDraggingFavoriteId] = useState<string | null>(null);
  const [favoriteDropTarget, setFavoriteDropTarget] = useState<FavoriteDropTarget | null>(null);
  const deferredFilter = useDeferredValue(filter);
  const navigate = useNavigate();

  // The overlay covers content — dismiss it once a nav click lands.
  const location = useLocation();
  const currentPath = location.pathname + location.search;
  useEffect(() => {
    if (overlay) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close on navigation only
  }, [currentPath]);

  // Cmd/Ctrl+1–9 jumps to the corresponding favorite. Digits come from
  // e.code so the physical number row works on any keyboard layout. Note the
  // browser may reserve Ctrl/Cmd+1–8 for its own tab switching; the desktop
  // app always receives them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!digit) return;
      const fav = hotkeyFavorites(useNavigationStore.getState().favorites)[Number(digit) - 1];
      if (!fav?.path) return;
      e.preventDefault();
      void navigate(fav.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const hotkeyByFavorite = useMemo(() => {
    const map = new Map<string, string>();
    hotkeyFavorites(favorites).forEach((fav, i) => map.set(fav.id, `${HOTKEY_MOD_LABEL}${i + 1}`));
    return map;
  }, [favorites]);

  const toggleGroup = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  const isFav = (id: string) => favorites.some((fav) => fav.id === id);
  const toggleCategory = (title: string) => {
    const id = `category:${title}`;
    if (isFav(id)) {
      removeFavorite(id);
    } else {
      addFavorite({ id, title });
      setCollapsed((prev) => new Set(prev).add(`fav:${title}`));
    }
  };

  const customKinds = useMemo(() => {
    const custom = dedupeCustomNavKinds((apiResources?.resources ?? []).filter((r) => r.custom && r.verbs.includes('list')));
    const byGroup = new Map<string, ResourceKindInfo[]>();
    for (const kind of custom) {
      const list = byGroup.get(kind.group) ?? [];
      list.push(kind);
      byGroup.set(kind.group, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [apiResources]);
  const customNav = useMemo(() => buildCustomNav(customKinds), [customKinds]);

  // Group chain (outermost first) containing each kind path, used to reveal
  // the entry for the active resource after a cross-kind jump.
  const groupChainByPath = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const group of BUILTIN_NAV_GROUPS) {
      for (const k of group.kinds) map.set(kindPath(k.group, k.version, k.plural), [group.title]);
    }
    map.set(CRD_LIST_PATH, ['Custom Resources']);
    for (const node of customNav) {
      const nodeKey = `${CUSTOM_GROUP_PREFIX}${node.label}`;
      for (const k of node.kinds) map.set(kindPath(k.group, k.version, k.plural), ['Custom Resources', nodeKey]);
      for (const sg of node.subgroups) {
        for (const k of sg.kinds) {
          map.set(kindPath(k.group, k.version, k.plural), ['Custom Resources', nodeKey, `${CUSTOM_GROUP_PREFIX}${sg.group}`]);
        }
      }
    }
    return map;
  }, [customNav]);

  const listRef = useRef<HTMLUListElement | null>(null);
  // Bring the active entry into view. A just-expanded Collapse animates open,
  // growing the drawer's scroll range as it goes, so a single scroll lands
  // short; keep nudging each frame until the entry's position settles.
  // Favorites can render a second copy of the active entry; the canonical
  // group entry is the last match, and expanding its chain guarantees it
  // is present. Returns a canceller for use as an effect cleanup.
  const scrollActiveEntryIntoView = useCallback(() => {
    const deadline = performance.now() + 1200;
    let raf = 0;
    let lastTop: number | null = null;
    let stable = 0;
    const tick = () => {
      const entries = listRef.current?.querySelectorAll('.Mui-selected');
      const el = entries?.[entries.length - 1];
      if (el) {
        const top = el.getBoundingClientRect().top;
        stable = lastTop !== null && Math.abs(top - lastTop) < 0.5 ? stable + 1 : 0;
        lastTop = top;
        el.scrollIntoView({ block: 'nearest' });
        if (stable >= 5) return;
      }
      if (performance.now() < deadline) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  // When navigation lands on a kind (cross-resource jump, tab switch, deep
  // link), expand the groups containing it and bring the entry into view.
  // Guarded per path so discovery refetches don't reopen a group the user
  // collapsed afterwards; a custom kind's chain is unknown until discovery
  // arrives, so those retry once groupChainByPath fills in.
  const revealedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (revealedPathRef.current === location.pathname) return;
    const chain = groupChainByPath.get(location.pathname);
    if (!chain && location.pathname.startsWith('/r/')) return;
    revealedPathRef.current = location.pathname;
    if (chain) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        // Custom-group keys are an explicit open override, so open means
        // present in the set; every other title is open when absent.
        for (const title of chain) {
          if (title.startsWith(CUSTOM_GROUP_PREFIX)) next.add(title);
          else next.delete(title);
        }
        return next.size === prev.size && [...next].every((t) => prev.has(t)) ? prev : next;
      });
    }
    return scrollActiveEntryIntoView();
  }, [location.pathname, groupChainByPath, scrollActiveEntryIntoView]);

  // Clearing the filter re-collapses groups; keep the active entry in view
  // instead of letting the selection vanish with them.
  const prevFilterRef = useRef(deferredFilter);
  useEffect(() => {
    const hadFilter = !!prevFilterRef.current;
    prevFilterRef.current = deferredFilter;
    if (!hadFilter || deferredFilter) return;
    return scrollActiveEntryIntoView();
  }, [deferredFilter, scrollActiveEntryIntoView]);

  // The temporary drawer mounts its content only while open, so a reveal
  // that ran while it was closed expanded the groups but had no list to
  // scroll. Bring the active entry into view whenever the overlay opens.
  useEffect(() => {
    if (!overlay || !open) return;
    return scrollActiveEntryIntoView();
  }, [overlay, open, scrollActiveEntryIntoView]);

  // Kinds belonging to each favoritable category, used to expand a favorited
  // category inline under the Favorites group.
  const categoryKindsMap = useMemo(() => {
    const map = new Map<string, NavKind[]>();
    for (const group of BUILTIN_NAV_GROUPS) {
      map.set(
        group.title,
        group.kinds.map((k) => ({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: pluralLabel(k.kind) })),
      );
    }
    map.set(
      'Custom Resources',
      customKinds.flatMap(([, kinds]) => kinds.map((k) => ({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: k.kind }))),
    );
    return map;
  }, [customKinds]);

  const f = deferredFilter.toLowerCase();
  const matches = (label: string) => !f || label.toLowerCase().includes(f);
  // Branch containing the current page, for active-trail coloring in the tree.
  const activeChain = groupChainByPath.get(location.pathname) ?? [];
  // While filtering, always expand so matches are visible. CRD API groups are
  // discovered dynamically, so they use the set as an explicit open override.
  const isOpen = (title: string) => !!f || (title.startsWith(CUSTOM_GROUP_PREFIX) ? collapsed.has(title) : !collapsed.has(title));
  const canReorderFavorites = favorites.length > 1 && !f;
  const clearFavoriteDrag = () => {
    setDraggingFavoriteId(null);
    setFavoriteDropTarget(null);
  };
  const favoriteDragHandle = (fav: FavoriteItem) =>
    canReorderFavorites ? (
      <FavoriteDragHandle
        favorite={fav}
        onDragStart={(favorite, e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(FAVORITE_DRAG_TYPE, favorite.id);
          setDraggingFavoriteId(favorite.id);
        }}
        onDragEnd={clearFavoriteDrag}
      />
    ) : undefined;
  const favoriteDragShell = (fav: FavoriteItem, children: ReactNode) =>
    canReorderFavorites ? (
      <FavoriteDragShell
        favorite={fav}
        draggingId={draggingFavoriteId}
        dropTarget={favoriteDropTarget}
        onDropTarget={setFavoriteDropTarget}
        onClearDropTarget={(id) => {
          setFavoriteDropTarget((target) => (target?.id === id ? null : target));
        }}
        onDropFavorite={({ id, position }) => {
          const draggedId = draggingFavoriteId;
          clearFavoriteDrag();
          if (draggedId) moveFavorite(draggedId, id, position);
        }}
      >
        {children}
      </FavoriteDragShell>
    ) : (
      children
    );

  const railHidden = !overlay && hidden;
  return (
    <Drawer
      variant={overlay ? 'temporary' : 'permanent'}
      open={overlay ? open : true}
      onClose={onClose}
      sx={{
        width: overlay || railHidden ? 0 : WIDTH,
        flexShrink: 0,
        transition: 'width 150ms ease',
        '& .MuiDrawer-paper': {
          width: railHidden ? 0 : WIDTH,
          borderRight: railHidden ? 0 : 1,
          borderColor: 'divider',
          overflowY: 'auto',
          overflowX: 'hidden',
          bgcolor: (theme) => theme.palette.sidebar,
          ...(overlay
            ? { top: `${layout.topBarHeight}px`, height: `calc(100% - ${layout.topBarHeight}px)` }
            : { position: 'relative', transition: 'width 150ms ease' }),
        },
      }}
    >
      <Box sx={{ p: 1.25, pb: 0.5 }}>
        <TextField
          fullWidth
          placeholder="Filter resources…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (filter) setFilter('');
            else (e.target as HTMLElement).blur();
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
              endAdornment: filter ? (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="Clear resource filter"
                    edge="end"
                    size="small"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFilter('')}
                    sx={{ mr: -0.75 }}
                  >
                    <ClearIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
      </Box>
      <List dense disablePadding ref={listRef} sx={{ pb: 4 }}>
        <NavEntry to="/" label="Overview" icon={<SpaceDashboardOutlinedIcon />} />
        <NavEntry to="/events" label="Events" icon={<NotificationsNoneOutlinedIcon />} />
        <NavEntry to="/audit" label="Security Audit" icon={<GppMaybeOutlinedIcon />} />
        <NavEntry to="/topology" label="Topology" icon={<AccountTreeOutlinedIcon />} onIntent={preloadTopology} />
        <NavEntry to="/metrics" label="Metrics" icon={<QueryStatsOutlinedIcon />} />
        <NavEntry to="/network" label="Network Metrics" icon={<NetworkCheckOutlinedIcon />} />
        <NavEntry to="/helm" label="Helm Releases" icon={<SailingOutlinedIcon />} />
        <NavEntry to="/forwards" label="Port Forwards" icon={<CableOutlinedIcon />} />
        <NavEntry to="/diff" label="Diff" icon={<DifferenceOutlinedIcon />} />
        {favorites.length > 0 && (
          <Box>
            <GroupHeader title="Favorites" icon={<StarIcon />} open={isOpen('Favorites')} onClick={() => toggleGroup('Favorites')} />
            <Collapse in={isOpen('Favorites')}>
              {favorites.map((fav) => {
                if (fav.id.startsWith('category:')) {
                  const all = categoryKindsMap.get(fav.title) ?? [];
                  const titleMatch = matches(fav.title);
                  const kinds = titleMatch ? all : all.filter((k) => matches(k.kind));
                  if (f && !titleMatch && kinds.length === 0) return null;
                  const key = `fav:${fav.title}`;
                  return (
                    <Box key={fav.id}>
                      {favoriteDragShell(
                        fav,
                        <GroupHeader
                          title={fav.title}
                          icon={GROUP_ICONS[fav.title] ?? <ExtensionOutlinedIcon />}
                          open={isOpen(key)}
                          onClick={() => toggleGroup(key)}
                          favorite={{ active: true, onToggle: () => removeFavorite(fav.id) }}
                          favoriteAction={favoriteDragHandle(fav)}
                        />,
                      )}
                      <Collapse in={isOpen(key)}>
                        {kinds.map((k) => (
                          <NavEntry key={`${k.group}/${k.version}/${k.plural}`} to={kindPath(k.group, k.version, k.plural)} label={k.label} />
                        ))}
                      </Collapse>
                    </Box>
                  );
                }
                const subtitle = favoriteGvk(fav, apiResources?.resources ?? []);
                if (!matches(fav.title) && !(subtitle && matches(subtitle))) return null;
                return (
                  <Box key={fav.id}>
                    {favoriteDragShell(
                      fav,
                      <NavEntry
                        to={fav.path ?? '/'}
                        label={fav.title}
                        subtitle={subtitle}
                        favorite={fav}
                        favoriteAction={favoriteDragHandle(fav)}
                        hotkey={hotkeyByFavorite.get(fav.id)}
                      />,
                    )}
                  </Box>
                );
              })}
            </Collapse>
          </Box>
        )}
        {savedViews.length > 0 && (
          <Box>
            <GroupHeader title="Saved Views" icon={<SearchIcon />} open={isOpen('Saved Views')} onClick={() => toggleGroup('Saved Views')} />
            <Collapse in={isOpen('Saved Views')}>
              {savedViews.map((v) => (
                <SavedViewEntry key={v.id} view={v} onDelete={removeSavedView} />
              ))}
            </Collapse>
          </Box>
        )}
        {BUILTIN_NAV_GROUPS.map((group) => {
          const visible = group.kinds.filter((k) => matches(k.kind));
          if (!visible.length) return null;
          return (
            <Box key={group.title}>
              <GroupHeader
                title={group.title}
                icon={GROUP_ICONS[group.title]}
                open={isOpen(group.title)}
                onClick={() => toggleGroup(group.title)}
                favorite={{ active: isFav(`category:${group.title}`), onToggle: () => toggleCategory(group.title) }}
              />
              <Collapse in={isOpen(group.title)}>
                {visible.map((k) => (
                  <NavEntry
                    key={k.plural}
                    to={kindPath(k.group, k.version, k.plural)}
                    label={pluralLabel(k.kind)}
                    favorite={kindFavorite({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: pluralLabel(k.kind) })}
                  />
                ))}
              </Collapse>
            </Box>
          );
        })}
        {customKinds.length > 0 && (
          <>
            <GroupHeader
              title="Custom Resources"
              icon={<ExtensionOutlinedIcon />}
              open={isOpen('Custom Resources')}
              onClick={() => toggleGroup('Custom Resources')}
              favorite={{ active: isFav('category:Custom Resources'), onToggle: () => toggleCategory('Custom Resources') }}
            />
            <Collapse in={isOpen('Custom Resources')}>
              {(!f || 'crd definitions customresourcedefinitions'.includes(f)) && (
                <NavEntry
                  to={CRD_LIST_PATH}
                  label="Definitions"
                  favorite={kindFavorite({
                    group: 'apiextensions.k8s.io',
                    version: 'v1',
                    plural: 'customresourcedefinitions',
                    kind: 'CustomResourceDefinition',
                    label: 'CRD Definitions',
                  })}
                />
              )}
              {customNav.map((node) => {
                const nodeKey = `${CUSTOM_GROUP_PREFIX}${node.label}`;
                const nodeMatches = matches(node.label);
                const ownKinds = nodeMatches ? node.kinds : node.kinds.filter((k) => matches(k.kind));
                const subgroups = node.subgroups
                  .map((sg) => ({ ...sg, kinds: nodeMatches || matches(sg.group) ? sg.kinds : sg.kinds.filter((k) => matches(k.kind)) }))
                  .filter((sg) => sg.kinds.length > 0);
                if (!ownKinds.length && !subgroups.length) return null;
                const kindCount = node.kinds.length + node.subgroups.reduce((n, sg) => n + sg.kinds.length, 0);
                return (
                  <Box key={node.label}>
                    <CustomGroupHeader
                      label={node.label}
                      count={kindCount}
                      indent={ITEM_INDENT}
                      open={isOpen(nodeKey)}
                      active={activeChain.includes(nodeKey)}
                      onClick={() => toggleGroup(nodeKey)}
                    />
                    <Collapse in={isOpen(nodeKey)}>
                      <TreeChildren railLeft="45px" active={activeChain.includes(nodeKey)}>
                        {ownKinds.map((k) => (
                          <NavEntry
                            key={`${k.group}/${k.version}/${k.plural}`}
                            to={kindPath(k.group, k.version, k.plural)}
                            label={k.kind}
                            indent={SUB_INDENT}
                            favorite={kindFavorite({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: k.kind })}
                          />
                        ))}
                        {subgroups.map((sg) => {
                          const sgKey = `${CUSTOM_GROUP_PREFIX}${sg.group}`;
                          return (
                            <Box key={sg.group}>
                              <CustomGroupHeader
                                label={sg.label}
                                title={sg.group}
                                count={sg.kinds.length}
                                indent={SUB_INDENT}
                                open={isOpen(sgKey)}
                                active={activeChain.includes(sgKey)}
                                onClick={() => toggleGroup(sgKey)}
                              />
                              <Collapse in={isOpen(sgKey)}>
                                <TreeChildren>
                                  {sg.kinds.map((k) => (
                                    <NavEntry
                                      key={`${k.group}/${k.version}/${k.plural}`}
                                      to={kindPath(k.group, k.version, k.plural)}
                                      label={k.kind}
                                      indent={KIND_INDENT}
                                      favorite={kindFavorite({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: k.kind })}
                                    />
                                  ))}
                                </TreeChildren>
                              </Collapse>
                            </Box>
                          );
                        })}
                      </TreeChildren>
                    </Collapse>
                  </Box>
                );
              })}
            </Collapse>
          </>
        )}
      </List>
    </Drawer>
  );
});
