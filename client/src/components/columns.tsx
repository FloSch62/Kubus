import type { GridColDef } from '@mui/x-data-grid';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import { evalPrinterColumnPath, type KubeObject, type MetricsSnapshot, type PrinterColumn } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import { AgeCell } from './AgeCell.js';
import { ReadyCounter } from './ReadyCounter.js';
import { StatusChip } from './StatusChip.js';
import { formatBytes, formatCpu } from './Sparkline.js';
import { dataKeyCount, eventFields, hasRunningDebugContainer, ingressHosts, jobStatus, nodeAddress, nodeConditions, nodeRoles, nodeStatus, nodeTaints, parseQuantity, podSummary, serviceLoadBalancerAddresses, servicePorts, workloadReady } from '../kube-display.js';

export type MetricsLookup = (ctx: string, namespace: string | undefined, name: string) => { cpuMilli: number; memBytes: number; cpuCapacityMilli?: number; memCapacityBytes?: number } | undefined;
export type NodeAllocationLookup = (ctx: string, nodeName: string) => NodeAllocationSummary;

type Col = GridColDef<ClusterRow>;

interface ColumnBuildOptions {
  multiCluster: boolean;
  metrics?: MetricsLookup;
  nodeAllocation?: NodeAllocationLookup;
  /** Clicking a label chip adds that `key=value` term to the label filter. */
  onLabelClick?: (term: string) => void;
}

export interface NodeAllocationSummary {
  podCount: number;
  daemonSetPodCount: number;
  cpuRequestMilli: number;
  memoryRequestBytes: number;
}

function obj(row: ClusterRow): KubeObject {
  return row.obj;
}

const podSummaryCache = new WeakMap<KubeObject, ReturnType<typeof podSummary>>();

function cachedPodSummary(o: KubeObject): ReturnType<typeof podSummary> {
  let summary = podSummaryCache.get(o);
  if (!summary) {
    summary = podSummary(o);
    podSummaryCache.set(o, summary);
  }
  return summary;
}

const eventFieldsCache = new WeakMap<KubeObject, ReturnType<typeof eventFields>>();

function cachedEventFields(o: KubeObject): ReturnType<typeof eventFields> {
  let fields = eventFieldsCache.get(o);
  if (!fields) {
    fields = eventFields(o);
    eventFieldsCache.set(o, fields);
  }
  return fields;
}

/** Build DataGrid column definitions from semantic column ids. */
export function buildColumns(columnIds: string[], opts: ColumnBuildOptions): Col[] {
  const cols: Col[] = [];
  for (const id of columnIds) {
    if (id === 'cluster' && !opts.multiCluster) continue;
    const col = COLUMN_DEFS[id]?.(opts);
    if (col) cols.push(col);
  }
  return cols;
}

const COLUMN_DEFS: Record<string, (opts: ColumnBuildOptions) => Col> = {
  labels: (opts) => ({
    field: 'labels',
    headerName: 'Labels',
    flex: 1,
    minWidth: 220,
    sortable: false,
    valueGetter: (_v, row) =>
      Object.entries(obj(row).metadata.labels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
    renderCell: (params) => <LabelsCell labels={obj(params.row).metadata.labels} onLabelClick={opts.onLabelClick} />,
  }),
  name: () => ({
    field: 'name',
    headerName: 'Name',
    flex: 1.4,
    minWidth: 180,
    valueGetter: (_v, row) => obj(row).metadata.name,
  }),
  namespace: () => ({
    field: 'namespace',
    headerName: 'Namespace',
    width: 130,
    valueGetter: (_v, row) => obj(row).metadata.namespace ?? '',
  }),
  cluster: () => ({
    field: 'cluster',
    headerName: 'Cluster',
    width: 140,
    valueGetter: (_v, row) => row.ctx,
  }),
  age: () => ({
    field: 'age',
    headerName: 'Age',
    width: 80,
    valueGetter: (_v, row) => obj(row).metadata.creationTimestamp ?? '',
    renderCell: (params) => <AgeCell timestamp={obj(params.row).metadata.creationTimestamp} />,
  }),
  ready: () => ({
    field: 'ready',
    headerName: 'Ready',
    width: 75,
    valueGetter: (_v, row) => cachedPodSummary(obj(row)).ready,
    renderCell: (params) => <ReadyCounter value={String(params.value ?? '')} />,
  }),
  podStatus: () => ({
    field: 'podStatus',
    headerName: 'Status',
    width: 150,
    valueGetter: (_v, row) => cachedPodSummary(obj(row)).status,
    renderCell: (params) => (
      <>
        <StatusChip status={cachedPodSummary(obj(params.row)).status} />
        {hasRunningDebugContainer(obj(params.row)) && (
          <Tooltip title="A debug container is running in this pod">
            <BugReportOutlinedIcon color="warning" sx={{ fontSize: 15, ml: 0.5, verticalAlign: 'middle' }} />
          </Tooltip>
        )}
      </>
    ),
  }),
  restarts: () => ({
    field: 'restarts',
    headerName: 'Restarts',
    width: 80,
    type: 'number',
    valueGetter: (_v, row) => cachedPodSummary(obj(row)).restarts,
  }),
  node: () => ({
    field: 'node',
    headerName: 'Node',
    width: 150,
    valueGetter: (_v, row) => cachedPodSummary(obj(row)).node ?? '',
  }),
  cpu: (opts) => ({
    field: 'cpu',
    headerName: 'CPU',
    width: 90,
    type: 'number',
    valueGetter: (_v, row) => opts.metrics?.(row.ctx, obj(row).metadata.namespace, obj(row).metadata.name)?.cpuMilli ?? null,
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, obj(params.row).metadata.namespace, obj(params.row).metadata.name);
      return m ? formatCpu(m.cpuMilli) : '—';
    },
  }),
  memory: (opts) => ({
    field: 'memory',
    headerName: 'Memory',
    width: 90,
    type: 'number',
    valueGetter: (_v, row) => opts.metrics?.(row.ctx, obj(row).metadata.namespace, obj(row).metadata.name)?.memBytes ?? null,
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, obj(params.row).metadata.namespace, obj(params.row).metadata.name);
      return m ? formatBytes(m.memBytes) : '—';
    },
  }),
  nodePods: (opts) => ({
    field: 'nodePods',
    headerName: 'Pods',
    width: 110,
    type: 'number',
    valueGetter: (_v, row) => opts.nodeAllocation?.(row.ctx, obj(row).metadata.name).podCount ?? 0,
    renderCell: (params) => {
      const summary = opts.nodeAllocation?.(params.row.ctx, obj(params.row).metadata.name) ?? EMPTY_NODE_ALLOCATION;
      const podCapacity = nodeAllocatablePods(obj(params.row));
      const text = `${summary.podCount}${summary.daemonSetPodCount ? ` (${summary.daemonSetPodCount} ds)` : ''}`;
      return (
        <Tooltip title={podCapacity ? `${summary.podCount} / ${podCapacity} allocatable pods` : text}>
          <Typography variant="body2" noWrap>
            {text}
          </Typography>
        </Tooltip>
      );
    },
  }),
  nodeCpuUsage: (opts) => ({
    field: 'nodeCpuUsage',
    headerName: 'CPU Usage',
    width: 130,
    type: 'number',
    valueGetter: (_v, row) => {
      const m = opts.metrics?.(row.ctx, undefined, obj(row).metadata.name);
      const capacity = m?.cpuCapacityMilli ?? nodeAllocatableCpuMilli(obj(row));
      return m && capacity ? (m.cpuMilli / capacity) * 100 : null;
    },
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, undefined, obj(params.row).metadata.name);
      const capacity = m?.cpuCapacityMilli ?? nodeAllocatableCpuMilli(obj(params.row));
      return (
        <RatioBarCell
          value={m && capacity ? (m.cpuMilli / capacity) * 100 : undefined}
          label={m ? `${formatCpu(m.cpuMilli)}${capacity ? ` / ${formatCpu(capacity)}` : ''}` : undefined}
        />
      );
    },
  }),
  nodeMemoryUsage: (opts) => ({
    field: 'nodeMemoryUsage',
    headerName: 'Memory Usage',
    width: 145,
    type: 'number',
    valueGetter: (_v, row) => {
      const m = opts.metrics?.(row.ctx, undefined, obj(row).metadata.name);
      const capacity = m?.memCapacityBytes ?? nodeAllocatableMemoryBytes(obj(row));
      return m && capacity ? (m.memBytes / capacity) * 100 : null;
    },
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, undefined, obj(params.row).metadata.name);
      const capacity = m?.memCapacityBytes ?? nodeAllocatableMemoryBytes(obj(params.row));
      return (
        <RatioBarCell
          value={m && capacity ? (m.memBytes / capacity) * 100 : undefined}
          label={m ? `${formatBytes(m.memBytes)}${capacity ? ` / ${formatBytes(capacity)}` : ''}` : undefined}
        />
      );
    },
  }),
  nodeCpuAllocation: (opts) => ({
    field: 'nodeCpuAllocation',
    headerName: 'CPU Allocation',
    width: 145,
    type: 'number',
    valueGetter: (_v, row) => {
      const allocatable = nodeAllocatableCpuMilli(obj(row));
      const request = opts.nodeAllocation?.(row.ctx, obj(row).metadata.name).cpuRequestMilli ?? 0;
      return allocatable ? (request / allocatable) * 100 : null;
    },
    renderCell: (params) => {
      const allocatable = nodeAllocatableCpuMilli(obj(params.row));
      const request = opts.nodeAllocation?.(params.row.ctx, obj(params.row).metadata.name).cpuRequestMilli ?? 0;
      return <RatioBarCell value={allocatable ? (request / allocatable) * 100 : undefined} label={allocatable ? `${formatCpu(request)} / ${formatCpu(allocatable)}` : undefined} />;
    },
  }),
  nodeMemoryAllocation: (opts) => ({
    field: 'nodeMemoryAllocation',
    headerName: 'Memory Allocation',
    width: 165,
    type: 'number',
    valueGetter: (_v, row) => {
      const allocatable = nodeAllocatableMemoryBytes(obj(row));
      const request = opts.nodeAllocation?.(row.ctx, obj(row).metadata.name).memoryRequestBytes ?? 0;
      return allocatable ? (request / allocatable) * 100 : null;
    },
    renderCell: (params) => {
      const allocatable = nodeAllocatableMemoryBytes(obj(params.row));
      const request = opts.nodeAllocation?.(params.row.ctx, obj(params.row).metadata.name).memoryRequestBytes ?? 0;
      return <RatioBarCell value={allocatable ? (request / allocatable) * 100 : undefined} label={allocatable ? `${formatBytes(request)} / ${formatBytes(allocatable)}` : undefined} />;
    },
  }),
  workloadReady: () => ({
    field: 'workloadReady',
    headerName: 'Ready',
    width: 80,
    valueGetter: (_v, row) => workloadReady(obj(row)),
    renderCell: (params) => <ReadyCounter value={String(params.value ?? '')} />,
  }),
  upToDate: () => ({
    field: 'upToDate',
    headerName: 'Up-to-date',
    width: 90,
    valueGetter: (_v, row) => ((obj(row).status as { updatedReplicas?: number })?.updatedReplicas ?? 0).toString(),
  }),
  available: () => ({
    field: 'available',
    headerName: 'Available',
    width: 85,
    valueGetter: (_v, row) => ((obj(row).status as { availableReplicas?: number })?.availableReplicas ?? 0).toString(),
  }),
  dsDesired: () => ({
    field: 'dsDesired',
    headerName: 'Desired',
    width: 80,
    valueGetter: (_v, row) => ((obj(row).status as { desiredNumberScheduled?: number })?.desiredNumberScheduled ?? 0).toString(),
  }),
  dsReady: () => ({
    field: 'dsReady',
    headerName: 'Ready',
    width: 75,
    valueGetter: (_v, row) => ((obj(row).status as { numberReady?: number })?.numberReady ?? 0).toString(),
  }),
  jobCompletions: () => ({
    field: 'jobCompletions',
    headerName: 'Completions',
    width: 105,
    valueGetter: (_v, row) => jobStatus(obj(row)).completions,
  }),
  jobDuration: () => ({
    field: 'jobDuration',
    headerName: 'Duration',
    width: 90,
    valueGetter: (_v, row) => jobStatus(obj(row)).duration,
  }),
  cronSchedule: () => ({
    field: 'cronSchedule',
    headerName: 'Schedule',
    width: 110,
    valueGetter: (_v, row) => (obj(row).spec as { schedule?: string })?.schedule ?? '',
  }),
  cronSuspend: () => ({
    field: 'cronSuspend',
    headerName: 'Suspended',
    width: 90,
    valueGetter: (_v, row) => String((obj(row).spec as { suspend?: boolean })?.suspend ?? false),
  }),
  cronLastSchedule: () => ({
    field: 'cronLastSchedule',
    headerName: 'Last run',
    width: 90,
    valueGetter: (_v, row) => (obj(row).status as { lastScheduleTime?: string })?.lastScheduleTime ?? '',
    renderCell: (params) => <AgeCell timestamp={(obj(params.row).status as { lastScheduleTime?: string })?.lastScheduleTime} />,
  }),
  svcType: () => ({
    field: 'svcType',
    headerName: 'Type',
    width: 110,
    valueGetter: (_v, row) => (obj(row).spec as { type?: string })?.type ?? '',
  }),
  svcClusterIP: () => ({
    field: 'svcClusterIP',
    headerName: 'Cluster IP',
    width: 120,
    valueGetter: (_v, row) => (obj(row).spec as { clusterIP?: string })?.clusterIP ?? '',
  }),
  svcLoadBalancerIP: () => ({
    field: 'svcLoadBalancerIP',
    headerName: 'Load Balancer IP',
    width: 150,
    valueGetter: (_v, row) => serviceLoadBalancerAddresses(obj(row)),
  }),
  svcPorts: () => ({
    field: 'svcPorts',
    headerName: 'Ports',
    flex: 1,
    minWidth: 140,
    valueGetter: (_v, row) => servicePorts(obj(row)),
  }),
  ingressClass: () => ({
    field: 'ingressClass',
    headerName: 'Class',
    width: 100,
    valueGetter: (_v, row) => (obj(row).spec as { ingressClassName?: string })?.ingressClassName ?? '',
  }),
  ingressHosts: () => ({
    field: 'ingressHosts',
    headerName: 'Hosts',
    flex: 1,
    minWidth: 150,
    valueGetter: (_v, row) => ingressHosts(obj(row)),
  }),
  dataKeys: () => ({
    field: 'dataKeys',
    headerName: 'Keys',
    width: 70,
    type: 'number',
    valueGetter: (_v, row) => dataKeyCount(obj(row)),
  }),
  secretType: () => ({
    field: 'secretType',
    headerName: 'Type',
    flex: 1,
    minWidth: 160,
    valueGetter: (_v, row) => (obj(row) as { type?: string }).type ?? '',
  }),
  pvcStatus: () => ({
    field: 'pvcStatus',
    headerName: 'Status',
    width: 100,
    valueGetter: (_v, row) => (obj(row).status as { phase?: string })?.phase ?? '',
    renderCell: (params) => <StatusChip status={(obj(params.row).status as { phase?: string })?.phase ?? ''} />,
  }),
  pvcCapacity: () => ({
    field: 'pvcCapacity',
    headerName: 'Capacity',
    width: 90,
    valueGetter: (_v, row) => ((obj(row).status as { capacity?: { storage?: string } })?.capacity?.storage ?? ''),
  }),
  pvcStorageClass: () => ({
    field: 'pvcStorageClass',
    headerName: 'StorageClass',
    width: 120,
    valueGetter: (_v, row) => (obj(row).spec as { storageClassName?: string })?.storageClassName ?? '',
  }),
  pvCapacity: () => ({
    field: 'pvCapacity',
    headerName: 'Capacity',
    width: 90,
    valueGetter: (_v, row) => ((obj(row).spec as { capacity?: { storage?: string } })?.capacity?.storage ?? ''),
  }),
  pvStatus: () => ({
    field: 'pvStatus',
    headerName: 'Status',
    width: 100,
    valueGetter: (_v, row) => (obj(row).status as { phase?: string })?.phase ?? '',
    renderCell: (params) => <StatusChip status={(obj(params.row).status as { phase?: string })?.phase ?? ''} />,
  }),
  pvClaim: () => ({
    field: 'pvClaim',
    headerName: 'Claim',
    flex: 1,
    minWidth: 140,
    valueGetter: (_v, row) => {
      const ref = (obj(row).spec as { claimRef?: { namespace?: string; name?: string } })?.claimRef;
      return ref ? `${ref.namespace}/${ref.name}` : '';
    },
  }),
  nodeStatus: () => ({
    field: 'nodeStatus',
    headerName: 'Status',
    width: 170,
    valueGetter: (_v, row) => nodeStatus(obj(row)),
    renderCell: (params) => <StatusChip status={nodeStatus(obj(params.row))} />,
  }),
  nodeRoles: () => ({
    field: 'nodeRoles',
    headerName: 'Roles',
    width: 130,
    valueGetter: (_v, row) => nodeRoles(obj(row)),
  }),
  nodeVersion: () => ({
    field: 'nodeVersion',
    headerName: 'kubelet',
    width: 130,
    valueGetter: (_v, row) => ((obj(row).status as { nodeInfo?: { kubeletVersion?: string } })?.nodeInfo?.kubeletVersion ?? ''),
  }),
  nodeOperatingSystem: () => ({
    field: 'nodeOperatingSystem',
    headerName: 'Operating System',
    width: 180,
    valueGetter: (_v, row) => ((obj(row).status as { nodeInfo?: { osImage?: string } })?.nodeInfo?.osImage ?? ''),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  nodeKernelVersion: () => ({
    field: 'nodeKernelVersion',
    headerName: 'Kernel Version',
    width: 150,
    valueGetter: (_v, row) => ((obj(row).status as { nodeInfo?: { kernelVersion?: string } })?.nodeInfo?.kernelVersion ?? ''),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  nodeContainerRuntime: () => ({
    field: 'nodeContainerRuntime',
    headerName: 'Container Runtime',
    width: 170,
    valueGetter: (_v, row) => ((obj(row).status as { nodeInfo?: { containerRuntimeVersion?: string } })?.nodeInfo?.containerRuntimeVersion ?? ''),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  nodeInternalIp: () => ({
    field: 'nodeInternalIp',
    headerName: 'Internal IP',
    width: 130,
    valueGetter: (_v, row) => nodeAddress(obj(row), 'InternalIP'),
  }),
  nodeExternalIp: () => ({
    field: 'nodeExternalIp',
    headerName: 'External IP',
    width: 130,
    valueGetter: (_v, row) => nodeAddress(obj(row), 'ExternalIP'),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  nodeTaints: () => ({
    field: 'nodeTaints',
    headerName: 'Taints',
    width: 180,
    valueGetter: (_v, row) => nodeTaints(obj(row)),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  nodeConditions: () => ({
    field: 'nodeConditions',
    headerName: 'Conditions',
    width: 180,
    valueGetter: (_v, row) => nodeConditions(obj(row)),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  nsStatus: () => ({
    field: 'nsStatus',
    headerName: 'Status',
    width: 100,
    valueGetter: (_v, row) => (obj(row).status as { phase?: string })?.phase ?? '',
    renderCell: (params) => <StatusChip status={(obj(params.row).status as { phase?: string })?.phase ?? ''} />,
  }),
  eventType: () => ({
    field: 'eventType',
    headerName: 'Type',
    width: 90,
    valueGetter: (_v, row) => cachedEventFields(obj(row)).type,
    renderCell: (params) => <StatusChip status={cachedEventFields(obj(params.row)).type === 'Warning' ? 'Error' : 'Ready'} />,
  }),
  eventReason: () => ({
    field: 'eventReason',
    headerName: 'Reason',
    width: 140,
    valueGetter: (_v, row) => cachedEventFields(obj(row)).reason,
  }),
  eventObject: () => ({
    field: 'eventObject',
    headerName: 'Object',
    width: 220,
    valueGetter: (_v, row) => cachedEventFields(obj(row)).object,
  }),
  eventMessage: () => ({
    field: 'eventMessage',
    headerName: 'Message',
    flex: 2,
    minWidth: 240,
    valueGetter: (_v, row) => cachedEventFields(obj(row)).message,
  }),
  eventCount: () => ({
    field: 'eventCount',
    headerName: 'Count',
    width: 70,
    type: 'number',
    valueGetter: (_v, row) => cachedEventFields(obj(row)).count,
  }),
  eventLastSeen: () => ({
    field: 'eventLastSeen',
    headerName: 'Last seen',
    width: 95,
    valueGetter: (_v, row) => cachedEventFields(obj(row)).lastSeen ?? '',
    renderCell: (params) => <AgeCell timestamp={cachedEventFields(obj(params.row)).lastSeen} />,
  }),
  hpaTarget: () => ({
    field: 'hpaTarget',
    headerName: 'Target',
    flex: 1,
    minWidth: 140,
    valueGetter: (_v, row) => {
      const ref = (obj(row).spec as { scaleTargetRef?: { kind?: string; name?: string } })?.scaleTargetRef;
      return ref ? `${ref.kind}/${ref.name}` : '';
    },
  }),
  hpaMinMax: () => ({
    field: 'hpaMinMax',
    headerName: 'Min/Max',
    width: 90,
    valueGetter: (_v, row) => {
      const spec = obj(row).spec as { minReplicas?: number; maxReplicas?: number } | undefined;
      return `${spec?.minReplicas ?? 1}/${spec?.maxReplicas ?? '?'}`;
    },
  }),
  hpaReplicas: () => ({
    field: 'hpaReplicas',
    headerName: 'Replicas',
    width: 80,
    valueGetter: (_v, row) => ((obj(row).status as { currentReplicas?: number })?.currentReplicas ?? 0).toString(),
  }),
};

const EMPTY_NODE_ALLOCATION: NodeAllocationSummary = {
  podCount: 0,
  daemonSetPodCount: 0,
  cpuRequestMilli: 0,
  memoryRequestBytes: 0,
};

const LABEL_CELL_VISIBLE = 2;

function LabelsCell({ labels, onLabelClick }: { labels?: Record<string, string>; onLabelClick?: (term: string) => void }) {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  const visible = entries.slice(0, LABEL_CELL_VISIBLE);
  const overflow = entries.length - visible.length;
  const chip = ([key, value]: [string, string]) => {
    const term = value ? `${key}=${value}` : key;
    return (
      <Chip
        key={key}
        label={term}
        size="small"
        variant="outlined"
        onClick={
          onLabelClick
            ? (event) => {
                event.stopPropagation();
                onLabelClick(term);
              }
            : undefined
        }
        sx={{ maxWidth: 170, height: 20, fontSize: 11 }}
      />
    );
  };
  return (
    <Tooltip
      placement="bottom-start"
      arrow={false}
      slotProps={{
        tooltip: {
          sx: {
            bgcolor: 'background.paper',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: 4,
            maxWidth: 480,
            p: 1,
          },
        },
      }}
      title={
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {entries.map(chip)}
        </Box>
      }
    >
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
        {visible.map(chip)}
        {overflow > 0 && <Chip label={`+${overflow}`} size="small" sx={{ height: 20, fontSize: 11, flexShrink: 0 }} />}
      </Box>
    </Tooltip>
  );
}

function TextCell({ value }: { value: string }) {
  const text = value || '-';
  return (
    <Tooltip title={text}>
      <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
        {text}
      </Typography>
    </Tooltip>
  );
}

function RatioBarCell({ value, label }: { value?: number; label?: string }) {
  if (value === undefined || Number.isNaN(value)) return <TextCell value="" />;
  const capped = Math.max(0, Math.min(100, value));
  const color = value >= 90 ? 'error' : value >= 75 ? 'warning' : 'primary';
  return (
    <Tooltip title={label ?? `${value.toFixed(0)}%`}>
      <Box sx={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ width: 38, flexShrink: 0, fontWeight: 600 }}>
          {value >= 1000 ? '999+%' : `${value.toFixed(0)}%`}
        </Typography>
        <LinearProgress
          variant="determinate"
          value={capped}
          color={color}
          sx={{ flex: 1, minWidth: 42, height: 5, borderRadius: 999, bgcolor: 'action.hover' }}
        />
      </Box>
    </Tooltip>
  );
}

function nodeAllocatable(node: KubeObject, key: string): string | undefined {
  return (node.status as { allocatable?: Record<string, string> } | undefined)?.allocatable?.[key];
}

function nodeAllocatableCpuMilli(node: KubeObject): number {
  return Math.round(parseQuantity(nodeAllocatable(node, 'cpu')) * 1000);
}

function nodeAllocatableMemoryBytes(node: KubeObject): number {
  return Math.round(parseQuantity(nodeAllocatable(node, 'memory')));
}

function nodeAllocatablePods(node: KubeObject): number {
  return Math.round(parseQuantity(nodeAllocatable(node, 'pods')));
}

function podNodeName(pod: KubeObject): string | undefined {
  return (pod.spec as { nodeName?: string } | undefined)?.nodeName;
}

function isTerminalPod(pod: KubeObject): boolean {
  const phase = (pod.status as { phase?: string } | undefined)?.phase;
  return phase === 'Succeeded' || phase === 'Failed';
}

function isDaemonSetPod(pod: KubeObject): boolean {
  return (pod.metadata.ownerReferences ?? []).some((owner) => owner.kind === 'DaemonSet');
}

interface ContainerWithRequests {
  restartPolicy?: string;
  resources?: { requests?: Record<string, string> };
}

function podRequestTotals(pod: KubeObject): { cpuMilli: number; memoryBytes: number } {
  const spec = pod.spec as
    | {
        containers?: ContainerWithRequests[];
        initContainers?: ContainerWithRequests[];
        overhead?: Record<string, string>;
      }
    | undefined;
  const containers = spec?.containers ?? [];
  const initContainers = spec?.initContainers ?? [];
  let appCpu = 0;
  let appMemory = 0;
  for (const c of containers) {
    appCpu += parseCpuRequest(c);
    appMemory += parseMemoryRequest(c);
  }
  let sidecarCpu = 0;
  let sidecarMemory = 0;
  let initCpu = 0;
  let initMemory = 0;
  for (const c of initContainers) {
    if (isRestartableInitContainer(c)) {
      sidecarCpu += parseCpuRequest(c);
      sidecarMemory += parseMemoryRequest(c);
    } else {
      initCpu = Math.max(initCpu, parseCpuRequest(c));
      initMemory = Math.max(initMemory, parseMemoryRequest(c));
    }
  }
  return {
    cpuMilli: sidecarCpu + Math.max(appCpu, initCpu) + Math.round(parseQuantity(spec?.overhead?.cpu) * 1000),
    memoryBytes: sidecarMemory + Math.max(appMemory, initMemory) + Math.round(parseQuantity(spec?.overhead?.memory)),
  };
}

function isRestartableInitContainer(container: ContainerWithRequests): boolean {
  return container.restartPolicy === 'Always';
}

function parseCpuRequest(container: ContainerWithRequests): number {
  return Math.round(parseQuantity(container.resources?.requests?.cpu) * 1000);
}

function parseMemoryRequest(container: ContainerWithRequests): number {
  return Math.round(parseQuantity(container.resources?.requests?.memory));
}

export function makeNodeAllocationLookup(pods: ClusterRow[]): NodeAllocationLookup {
  const byNode = new Map<string, NodeAllocationSummary>();
  for (const row of pods) {
    if (isTerminalPod(row.obj)) continue;
    const nodeName = podNodeName(row.obj);
    if (!nodeName) continue;
    const key = `${row.ctx}\0${nodeName}`;
    const prev = byNode.get(key) ?? { ...EMPTY_NODE_ALLOCATION };
    const requests = podRequestTotals(row.obj);
    byNode.set(key, {
      podCount: prev.podCount + 1,
      daemonSetPodCount: prev.daemonSetPodCount + (isDaemonSetPod(row.obj) ? 1 : 0),
      cpuRequestMilli: prev.cpuRequestMilli + requests.cpuMilli,
      memoryRequestBytes: prev.memoryRequestBytes + requests.memoryBytes,
    });
  }
  return (ctx, nodeName) => byNode.get(`${ctx}\0${nodeName}`) ?? EMPTY_NODE_ALLOCATION;
}

/**
 * Columns from a CRD's additionalPrinterColumns. Values come from evaluating
 * the column's jsonPath against the live object; non-scalar results are
 * stringified and truncated. Fields are prefixed to avoid clashing with
 * preset column ids.
 */
export function buildCrdColumns(cols: PrinterColumn[]): Col[] {
  return cols.map((c, i): Col => {
    const numeric = c.type === 'integer' || c.type === 'number';
    const statusLike = /^(ready|readiness|state|status|phase|health|healthy|available)$/i.test(c.name.trim());
    const value = (row: ClusterRow): unknown => evalPrinterColumnPath(row.obj, c.jsonPath);
    return {
      field: `crd_${i}_${c.name}`,
      headerName: c.name,
      description: c.description,
      width: c.type === 'date' ? 95 : numeric ? 90 : 140,
      type: numeric ? 'number' : undefined,
      valueGetter: (_v, row) => {
        const v = value(row);
        if (v === undefined) return numeric ? null : '';
        if (numeric) return typeof v === 'number' ? v : Number(v);
        if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
        return '';
      },
      renderCell:
        c.type === 'date'
          ? (params) => <AgeCell timestamp={(value(params.row) as string | undefined) || undefined} />
          : statusLike
            ? (params) => <StatusChip status={String(params.value ?? '')} />
            : undefined,
    };
  });
}

/** Default-hidden fields for CRD columns marked priority > 0. */
export function crdHiddenFields(cols: PrinterColumn[]): string[] {
  return cols.flatMap((c, i) => ((c.priority ?? 0) > 0 ? [`crd_${i}_${c.name}`] : []));
}

/** Lookup helper bridging pod/node metrics snapshots into the column defs. */
export function makeMetricsLookup(kind: string, metrics: Map<string, MetricsSnapshot> | undefined): MetricsLookup | undefined {
  if (!metrics || (kind !== 'Pod' && kind !== 'Node')) return undefined;
  const indexes = new Map<string, Map<string, MetricsSnapshot['items'][number]>>();
  return (ctx, namespace, name) => {
    const snap = metrics.get(ctx);
    if (!snap?.available) return undefined;
    let index = indexes.get(ctx);
    if (!index) {
      index = new Map();
      for (const item of snap.items) {
        const key = kind === 'Node' ? item.name : `${item.namespace}\0${item.name}`;
        if (!index.has(key)) index.set(key, item);
      }
      indexes.set(ctx, index);
    }
    const entry = index.get(kind === 'Node' ? name : `${namespace}\0${name}`);
    return entry
      ? {
          cpuMilli: entry.cpuMilli,
          memBytes: entry.memBytes,
          cpuCapacityMilli: entry.cpuCapacityMilli,
          memCapacityBytes: entry.memCapacityBytes,
        }
      : undefined;
  };
}
