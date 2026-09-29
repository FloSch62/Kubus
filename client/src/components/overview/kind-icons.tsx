import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import DonutSmallOutlinedIcon from '@mui/icons-material/DonutSmallOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import FilterNoneOutlinedIcon from '@mui/icons-material/FilterNoneOutlined';
import InputOutlinedIcon from '@mui/icons-material/InputOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutlineOutlined';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SettingsEthernetOutlinedIcon from '@mui/icons-material/SettingsEthernetOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import StraightenOutlinedIcon from '@mui/icons-material/StraightenOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import UnfoldMoreOutlinedIcon from '@mui/icons-material/UnfoldMoreOutlined';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import ViewModuleOutlinedIcon from '@mui/icons-material/ViewModuleOutlined';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';

const ICONS: Record<string, React.ReactElement> = {
  Node: <DnsOutlinedIcon />,
  Namespace: <WorkspacesOutlinedIcon />,
  Pod: <ViewInArOutlinedIcon />,
  Deployment: <RocketLaunchOutlinedIcon />,
  StatefulSet: <LayersOutlinedIcon />,
  DaemonSet: <ViewModuleOutlinedIcon />,
  ReplicaSet: <FilterNoneOutlinedIcon />,
  Job: <PlayCircleOutlineIcon />,
  CronJob: <ScheduleOutlinedIcon />,
  Service: <LanOutlinedIcon />,
  Ingress: <InputOutlinedIcon />,
  Endpoints: <SettingsEthernetOutlinedIcon />,
  NetworkPolicy: <PolicyOutlinedIcon />,
  ConfigMap: <TuneOutlinedIcon />,
  Secret: <KeyOutlinedIcon />,
  HorizontalPodAutoscaler: <UnfoldMoreOutlinedIcon />,
  ResourceQuota: <DonutSmallOutlinedIcon />,
  LimitRange: <StraightenOutlinedIcon />,
  PodDisruptionBudget: <ShieldOutlinedIcon />,
  PersistentVolumeClaim: <StorageOutlinedIcon />,
  PersistentVolume: <StorageOutlinedIcon />,
  StorageClass: <CategoryOutlinedIcon />,
  ServiceAccount: <BadgeOutlinedIcon />,
  Role: <AdminPanelSettingsOutlinedIcon />,
  RoleBinding: <AdminPanelSettingsOutlinedIcon />,
  ClusterRole: <AdminPanelSettingsOutlinedIcon />,
  ClusterRoleBinding: <AdminPanelSettingsOutlinedIcon />,
  CustomResourceDefinition: <ExtensionOutlinedIcon />,
};

/** Icon for a builtin kind; custom resources share the extension glyph. */
export function kindIcon(kind: string): React.ReactElement {
  return ICONS[kind] ?? <ExtensionOutlinedIcon />;
}
