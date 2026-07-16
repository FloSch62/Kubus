import { memo, useDeferredValue, useMemo, useState, type DragEvent, type ReactNode } from 'react';
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
import { useClustersStore } from '../state/clusters.js';
import { useNavigationStore } from '../state/navigation.js';
import { useTabsStore } from '../state/tabs.js';
import { GROUP_ICONS } from './tab-meta.js';

const WIDTH = 228;
// Indent of group items so they line up under the group label (button pl 16px + icon 26px).
const ITEM_INDENT = '42px';
const FAVORITE_DRAG_TYPE = 'application/x-kubus-favorite';
const CUSTOM_GROUP_PREFIX = 'custom:';

/**
 * Browser-style modifiers on nav links: Ctrl/Cmd+click opens a background
 * page tab (+Shift focuses it), middle-click opens a background tab.
 * Plain clicks keep navigating the active tab via NavLink.
 */
function useOpenInNewTab(to: string) {
  const openTab = useTabsStore((s) => s.openTab);
  const navigate = useNavigate();
  const open = (e: React.MouseEvent, foreground: boolean) => {
    e.preventDefault();
    openTab(to, { activate: foreground, afterActive: true });
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

function NavEntry({
  to,
  label,
  subtitle,
  icon,
  favorite,
  favoriteAction,
  onIntent,
}: {
  to: string;
  label: string;
  subtitle?: string;
  icon?: React.ReactElement;
  favorite?: FavoriteItem;
  favoriteAction?: ReactNode;
  /** Fired on hover/focus — used to preload the target's heavy chunks. */
  onIntent?: () => void;
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
      sx={{ pl: icon ? 1.5 : ITEM_INDENT, py: subtitle ? 0.25 : 0.375, pr: favorite ? (favoriteAction ? 7 : 4) : undefined }}
    >
      {icon && (
        <ListItemIcon sx={{ minWidth: 26, color: 'text.secondary', '& svg': { fontSize: 17 } }}>{icon}</ListItemIcon>
      )}
      <ListItemText
        primary={label}
        secondary={subtitle}
        sx={{ my: subtitle ? 0.25 : undefined }}
        slotProps={{
          primary: { variant: 'body2', noWrap: true, sx: subtitle ? { lineHeight: 1.25 } : undefined },
          secondary: { noWrap: true, title: subtitle, sx: { fontSize: 10.5, fontStyle: 'italic', lineHeight: 1.1 } },
        }}
      />
    </ListItemButton>
  );
  if (!favorite) return button;
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
          {favoriteAction}
          <FavStar
            active={isFav}
            label={`${isFav ? 'Remove' : 'Add'} favorite ${label}`}
            onToggle={() => (isFav ? removeFavorite(favorite.id) : addFavorite(favorite))}
          />
        </Box>
      }
      sx={{ '& .MuiListItemSecondaryAction-root': { right: 4 }, '&:hover .fav-star': { opacity: 1 } }}
    >
      {button}
    </ListItem>
  );
}

function SavedViewEntry({ view, onDelete }: { view: SavedView; onDelete: (id: string) => void }) {
  const location = useLocation();
  const active = `${location.pathname}${location.search}` === view.path;
  const newTabHandlers = useOpenInNewTab(view.path);
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
      <ListItemButton component={NavLink} to={view.path} dense selected={active} {...newTabHandlers} sx={{ pl: ITEM_INDENT, py: 0.375, pr: 4.5 }}>
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

export const NavDrawer = memo(function NavDrawer() {
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

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: WIDTH,
          position: 'relative',
          borderRight: 1,
          borderColor: 'divider',
          overflowY: 'auto',
          bgcolor: (theme) => (theme.palette.mode === 'dark' ? '#151518' : '#f4f4f5'),
        },
      }}
    >
      <Box sx={{ p: 1.25, pb: 0.5 }}>
        <TextField
          fullWidth
          placeholder="Filter resources…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
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
      <List dense disablePadding sx={{ pb: 4 }}>
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
              {customKinds.map(([groupName, kinds]) => {
                const groupMatches = matches(groupName);
                const visible = groupMatches ? kinds : kinds.filter((k) => matches(k.kind));
                if (!visible.length) return null;
                const collapseKey = `${CUSTOM_GROUP_PREFIX}${groupName}`;
                return (
                  <Box key={groupName}>
                    <ListItemButton
                      dense
                      aria-expanded={isOpen(collapseKey)}
                      onClick={() => toggleGroup(collapseKey)}
                      sx={{ pl: ITEM_INDENT, pr: 1.5, py: 0.25, mt: 0.5, color: 'text.secondary' }}
                    >
                      <ListItemText
                        primary={groupName}
                        slotProps={{ primary: { variant: 'caption', noWrap: true, title: groupName, sx: { fontWeight: 700, lineHeight: 1.4 } } }}
                      />
                      <ExpandMoreIcon
                        sx={{
                          ml: 0.5,
                          fontSize: 15,
                          opacity: 0.6,
                          transform: isOpen(collapseKey) ? 'none' : 'rotate(-90deg)',
                          transition: 'transform 120ms ease',
                        }}
                      />
                    </ListItemButton>
                    <Collapse in={isOpen(collapseKey)}>
                      {visible.map((k) => (
                        <NavEntry
                          key={`${k.group}/${k.version}/${k.plural}`}
                          to={kindPath(k.group, k.version, k.plural)}
                          label={k.kind}
                          favorite={kindFavorite({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: k.kind })}
                        />
                      ))}
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
