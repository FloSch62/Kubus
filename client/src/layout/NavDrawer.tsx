import { useDeferredValue, useMemo, useState } from 'react';
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
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import GppMaybeOutlinedIcon from '@mui/icons-material/GppMaybeOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import { NavLink, useLocation } from 'react-router';
import { BUILTIN_NAV_GROUPS, groupToPath, pluralLabel, type FavoriteItem, type ResourceKindInfo, type SavedView } from '@kubus/shared';
import { useApiResourcesForContexts } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useNavigationStore } from '../state/navigation.js';

const WIDTH = 228;
// Indent of group items so they line up under the group label (button pl 16px + icon 26px).
const ITEM_INDENT = '42px';

const GROUP_ICONS: Record<string, React.ReactElement> = {
  Workloads: <AppsOutlinedIcon />,
  Network: <LanOutlinedIcon />,
  Config: <TuneOutlinedIcon />,
  Storage: <StorageOutlinedIcon />,
  Cluster: <HubOutlinedIcon />,
  'Access Control': <AdminPanelSettingsOutlinedIcon />,
};

function kindPath(group: string, version: string, plural: string): string {
  return `/r/${groupToPath(group)}/${version}/${plural}`;
}

type NavKind = { group: string; version: string; plural: string; kind: string; label: string };

function kindFavorite(k: NavKind): FavoriteItem {
  return {
    id: `kind:${k.group}/${k.version}/${k.plural}`,
    title: k.label,
    subtitle: `${k.group || 'core'}/${k.version}`,
    path: kindPath(k.group, k.version, k.plural),
  };
}

// Star toggle revealed on row hover (always visible once active). Rendered as a
// <span> so it can sit inside a ListItemButton (group header) without nesting buttons.
function FavStar({ active, onToggle, label }: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <Tooltip title={active ? 'Remove favorite' : 'Add favorite'}>
      <IconButton
        component="span"
        role="button"
        aria-label={label}
        size="small"
        className="fav-star"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        sx={{
          opacity: active ? 1 : 0,
          color: active ? 'warning.main' : 'text.secondary',
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

function NavEntry({ to, label, icon, favorite }: { to: string; label: string; icon?: React.ReactElement; favorite?: FavoriteItem }) {
  const location = useLocation();
  const active = location.pathname === to;
  const isFav = useNavigationStore((s) => (favorite ? s.favorites.some((x) => x.id === favorite.id) : false));
  const addFavorite = useNavigationStore((s) => s.addFavorite);
  const removeFavorite = useNavigationStore((s) => s.removeFavorite);
  const button = (
    <ListItemButton component={NavLink} to={to} dense selected={active} sx={{ pl: icon ? 1.5 : ITEM_INDENT, py: 0.375, pr: favorite ? 4 : undefined }}>
      {icon && (
        <ListItemIcon sx={{ minWidth: 26, color: 'text.secondary', '& svg': { fontSize: 17 } }}>{icon}</ListItemIcon>
      )}
      <ListItemText primary={label} slotProps={{ primary: { variant: 'body2', noWrap: true } }} />
    </ListItemButton>
  );
  if (!favorite) return button;
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <FavStar
          active={isFav}
          label={`${isFav ? 'Remove' : 'Add'} favorite ${label}`}
          onToggle={() => (isFav ? removeFavorite(favorite.id) : addFavorite(favorite))}
        />
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
      <ListItemButton component={NavLink} to={view.path} dense selected={active} sx={{ pl: ITEM_INDENT, py: 0.375, pr: 4.5 }}>
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
}: {
  title: string;
  icon?: React.ReactElement;
  open: boolean;
  onClick: () => void;
  favorite?: { active: boolean; onToggle: () => void };
}) {
  return (
    <ListItemButton
      dense
      onClick={onClick}
      sx={{ mt: 1.25, py: 0.25, color: 'text.secondary', pr: favorite ? 5.5 : undefined, '&:hover .fav-star': { opacity: 1 } }}
    >
      <ListItemIcon sx={{ minWidth: 26, color: 'inherit', '& svg': { fontSize: 16 } }}>{icon}</ListItemIcon>
      <ListItemText
        primary={title}
        slotProps={{ primary: { variant: 'body2', sx: { fontWeight: 600, fontSize: 12.5, color: 'text.secondary' } } }}
      />
      {favorite && (
        <FavStar
          active={favorite.active}
          onToggle={favorite.onToggle}
          label={`${favorite.active ? 'Remove' : 'Add'} favorite category ${title}`}
        />
      )}
      <ExpandMoreIcon
        sx={{ fontSize: 16, opacity: 0.6, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms ease' }}
      />
    </ListItemButton>
  );
}

export function NavDrawer() {
  const selected = useClustersStore((s) => s.selected);
  const { data: apiResources } = useApiResourcesForContexts(selected);
  const favorites = useNavigationStore((s) => s.favorites);
  const savedViews = useNavigationStore((s) => s.savedViews);
  const removeSavedView = useNavigationStore((s) => s.removeSavedView);
  const addFavorite = useNavigationStore((s) => s.addFavorite);
  const removeFavorite = useNavigationStore((s) => s.removeFavorite);
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
  // While filtering, always expand so matches are visible.
  const isOpen = (title: string) => !!f || !collapsed.has(title);

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
        <NavEntry to="/topology" label="Topology" icon={<AccountTreeOutlinedIcon />} />
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
                      <GroupHeader
                        title={fav.title}
                        icon={GROUP_ICONS[fav.title] ?? <ExtensionOutlinedIcon />}
                        open={isOpen(key)}
                        onClick={() => toggleGroup(key)}
                        favorite={{ active: true, onToggle: () => removeFavorite(fav.id) }}
                      />
                      <Collapse in={isOpen(key)}>
                        {kinds.map((k) => (
                          <NavEntry key={`${k.group}/${k.version}/${k.plural}`} to={kindPath(k.group, k.version, k.plural)} label={k.label} />
                        ))}
                      </Collapse>
                    </Box>
                  );
                }
                if (!matches(fav.title)) return null;
                return <NavEntry key={fav.id} to={fav.path ?? '/'} label={fav.title} favorite={fav} />;
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
                const visible = kinds.filter((k) => matches(k.kind));
                if (!visible.length) return null;
                return (
                  <Box key={groupName}>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ pl: ITEM_INDENT, display: 'block', mt: 0.75, opacity: 0.8 }}
                      noWrap
                    >
                      {groupName}
                    </Typography>
                    {visible.map((k) => (
                      <NavEntry
                        key={`${k.group}/${k.version}/${k.plural}`}
                        to={kindPath(k.group, k.version, k.plural)}
                        label={k.kind}
                        favorite={kindFavorite({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, label: k.kind })}
                      />
                    ))}
                  </Box>
                );
              })}
            </Collapse>
          </>
        )}
      </List>
    </Drawer>
  );
}
