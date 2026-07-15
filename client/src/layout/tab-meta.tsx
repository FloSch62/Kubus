import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import DifferenceOutlinedIcon from '@mui/icons-material/DifferenceOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import QueryStatsOutlinedIcon from '@mui/icons-material/QueryStatsOutlined';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import GppMaybeOutlinedIcon from '@mui/icons-material/GppMaybeOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import { BUILTIN_NAV_GROUPS, groupFromPath, gvkForResource, pluralLabel, type ResourceKindInfo } from '@kubus/shared';

/** Sidebar/tab icons per builtin nav group (shared by NavDrawer and TabsBar). */
export const GROUP_ICONS: Record<string, React.ReactElement> = {
  Workloads: <AppsOutlinedIcon />,
  Network: <LanOutlinedIcon />,
  Config: <TuneOutlinedIcon />,
  Storage: <StorageOutlinedIcon />,
  Cluster: <HubOutlinedIcon />,
  'Access Control': <AdminPanelSettingsOutlinedIcon />,
};

const STATIC_PAGES: Record<string, { title: string; icon: React.ReactElement }> = {
  '/': { title: 'Overview', icon: <SpaceDashboardOutlinedIcon /> },
  '/events': { title: 'Events', icon: <NotificationsNoneOutlinedIcon /> },
  '/audit': { title: 'Security Audit', icon: <GppMaybeOutlinedIcon /> },
  '/topology': { title: 'Topology', icon: <AccountTreeOutlinedIcon /> },
  '/metrics': { title: 'Metrics', icon: <QueryStatsOutlinedIcon /> },
  '/helm': { title: 'Helm Releases', icon: <SailingOutlinedIcon /> },
  '/forwards': { title: 'Port Forwards', icon: <CableOutlinedIcon /> },
  '/diff': { title: 'Diff', icon: <DifferenceOutlinedIcon /> },
};

const NAV_GROUP_BY_RESOURCE = new Map<string, string>();
for (const navGroup of BUILTIN_NAV_GROUPS) {
  for (const gvk of navGroup.kinds) NAV_GROUP_BY_RESOURCE.set(`${gvk.group}/${gvk.plural}`, navGroup.title);
}

/**
 * Title + icon for a tab showing the given in-app path. Discovered kinds
 * (CRDs) resolve their label from `discovered`; until discovery lands the
 * capitalized plural is shown.
 */
export function tabMeta(path: string, discovered?: ResourceKindInfo[]): { title: string; icon: React.ReactElement } {
  const pathname = path.split('?')[0] ?? path;
  const staticPage = STATIC_PAGES[pathname];
  if (staticPage) return staticPage;
  if (pathname.startsWith('/helm/')) {
    const name = decodeURIComponent(pathname.split('/').at(-1) ?? '');
    return { title: name || 'Helm Release', icon: <SailingOutlinedIcon /> };
  }
  if (pathname.startsWith('/r/')) {
    const [, , pathGroup = 'core', version = '', plural = ''] = pathname.split('/');
    const group = groupFromPath(pathGroup);
    const builtin = gvkForResource(group, version, plural);
    const custom = builtin ? undefined : discovered?.find((r) => r.group === group && r.plural === plural);
    // Match NavDrawer labels: builtins pluralized, CRDs by kind name.
    const title = builtin ? pluralLabel(builtin.kind) : (custom?.kind ?? (plural ? plural.charAt(0).toUpperCase() + plural.slice(1) : 'Resources'));
    const groupTitle = NAV_GROUP_BY_RESOURCE.get(`${group}/${plural}`);
    const icon = (groupTitle && GROUP_ICONS[groupTitle]) || <ExtensionOutlinedIcon />;
    return { title, icon };
  }
  return { title: pathname.slice(1) || 'Kubus', icon: <SpaceDashboardOutlinedIcon /> };
}
