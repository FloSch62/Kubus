import { useMemo, useState } from 'react';
import {
  Box,
  Collapse,
  Drawer,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
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
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { NavLink, useLocation } from 'react-router';
import { BUILTIN_NAV_GROUPS, groupToPath, pluralLabel, type ResourceKindInfo, type SavedView } from '@kubus/shared';
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

function versionScore(version: string): [number, number, number] {
  const match = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(version);
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

function NavEntry({ to, label, icon }: { to: string; label: string; icon?: React.ReactElement }) {
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <ListItemButton component={NavLink} to={to} dense selected={active} sx={{ pl: icon ? 1.5 : ITEM_INDENT, py: 0.375 }}>
      {icon && (
        <ListItemIcon sx={{ minWidth: 26, color: 'text.secondary', '& svg': { fontSize: 17 } }}>{icon}</ListItemIcon>
      )}
      <ListItemText primary={label} slotProps={{ primary: { variant: 'body2', noWrap: true } }} />
    </ListItemButton>
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
            <DeleteOutlineIcon fontSize="small" />
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

function GroupHeader({ title, icon, open, onClick }: { title: string; icon?: React.ReactElement; open: boolean; onClick: () => void }) {
  return (
    <ListItemButton dense onClick={onClick} sx={{ mt: 1.25, py: 0.25, color: 'text.secondary' }}>
      <ListItemIcon sx={{ minWidth: 26, color: 'inherit', '& svg': { fontSize: 16 } }}>{icon}</ListItemIcon>
      <ListItemText
        primary={title}
        slotProps={{ primary: { variant: 'body2', sx: { fontWeight: 600, fontSize: 12.5, color: 'text.secondary' } } }}
      />
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['Custom Resources']));
  const [filter, setFilter] = useState('');

  const toggleGroup = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

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

  const f = filter.toLowerCase();
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
            },
          }}
        />
      </Box>
      <List dense disablePadding sx={{ pb: 4 }}>
        <NavEntry to="/" label="Overview" icon={<SpaceDashboardOutlinedIcon />} />
        <NavEntry to="/events" label="Events" icon={<NotificationsNoneOutlinedIcon />} />
        <NavEntry to="/topology" label="Topology" icon={<AccountTreeOutlinedIcon />} />
        <NavEntry to="/helm" label="Helm Releases" icon={<SailingOutlinedIcon />} />
        <NavEntry to="/forwards" label="Port Forwards" icon={<CableOutlinedIcon />} />
        <NavEntry to="/diff" label="Diff" icon={<DifferenceOutlinedIcon />} />
        {favorites.length > 0 && (
          <Box>
            <GroupHeader title="Favorites" icon={<SearchIcon />} open={isOpen('Favorites')} onClick={() => toggleGroup('Favorites')} />
            <Collapse in={isOpen('Favorites')}>
              {favorites.map((f) => (
                <NavEntry key={f.id} to={f.path ?? '/'} label={f.title} />
              ))}
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
              />
              <Collapse in={isOpen(group.title)}>
                {visible.map((k) => (
                  <NavEntry key={k.plural} to={kindPath(k.group, k.version, k.plural)} label={pluralLabel(k.kind)} />
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
                      <NavEntry key={`${k.group}/${k.version}/${k.plural}`} to={kindPath(k.group, k.version, k.plural)} label={k.kind} />
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
