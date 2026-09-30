import type { GridColDef } from '@mui/x-data-grid';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import { CellTooltip as Tooltip } from './CellTooltip.js';
import Typography from '@mui/material/Typography';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import { evalPrinterColumnPath, hpaMetrics, hpaMetricText, printerColumnText, type ClusterSignals, type KubeObject, type MetricsSnapshot, type ObjectSignal, type PrinterColumn } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import { AgeCell, RelativeTimeCell } from './AgeCell.js';
import { ReadyCounter } from './ReadyCounter.js';
import { StatusChip } from './StatusChip.js';
import { formatBytes, formatCpu } from './format.js';
import { crdStatus, crdVersions, dataKeyCount, eventFields, hasRunningDebugContainer, hpaProblems, ingressHosts, jobPhase, jobStatus, nodeAddress, nodeConditions, nodeRoles, nodeStatus, nodeTaints, ownerReference, parseQuantity, podRequestTotals, podSummary, serviceLoadBalancerAddresses, servicePorts, statusLikeName, workloadReady } from '../kube-display.js';
import { cronHumanText, cronNextRun } from '../cron.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { UsageMeter } from './UsageMeter.js';
import { withoutCellCopy } from './CellCopy.js';
import { statusTextColor } from '../theme.js';
import { MiddleEllipsis } from './truncation.js';
import { ClusterTag } from './ClusterTag.js';
import { statusColor } from './StatusChip.js';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

export type MetricsLookup = (ctx: string, namespace: string | undefined, name: string) => { cpuMilli: number; memBytes: number; cpuCapacityMilli?: number; memCapacityBytes?: number } | undefined;
export type NodeAllocationLookup = (ctx: string, nodeName: string) => NodeAllocationSummary;
/** Recent warning events / restarts for an object, keyed like the server's signals map. */
export type SignalsLookup = (ctx: string, kind: string, namespace: string | undefined, name: string, uid?: string) => ObjectSignal | undefined;

type Col = GridColDef<ClusterRow>;

interface ColumnBuildOptions {
  multiCluster: boolean;
  metrics?: MetricsLookup;
  nodeAllocation?: NodeAllocationLookup;
  /** Warning markers for the `signals` column; `signalKind` names the rows' kind (list objects carry no `kind`). */
  signals?: SignalsLookup;
  signalKind?: string;
  /** Clicking a label chip adds that `key=value` term to the label filter. */
  onLabelClick?: (term: string) => void;
  /** Palette slot per context for the Cluster tag (see clusterColorIndexes). */
  clusterColors?: ReadonlyMap<string, number>;
  /** Contexts whose metrics-server is unreachable: their CPU/Memory cells explain the dash. */
  metricsUnavailable?: readonly string[];
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

/**
 * Column ids whose defs close over the live metrics/allocation lookups.
 * Callers build these separately from the static columns so a metrics poll
 * swaps only these defs instead of invalidating the whole column set.
 */
export const METRIC_COLUMN_IDS = new Set(['cpu', 'memory', 'nodePods', 'nodeCpuUsage', 'nodeMemoryUsage', 'nodeCpuAllocation', 'nodeMemoryAllocation']);

/** Column carrying the warning marker; built with the signals lookup like the metric columns. */
export const SIGNALS_COLUMN_ID = 'signals';

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
  // The marker is an indicator, not a value: no copy button over it. The
  // header is the warning glyph; "Warnings" names it in the columns panel.
  signals: (opts) => withoutCellCopy({
    field: SIGNALS_COLUMN_ID,
    headerName: 'Warnings',
    description: 'Warning events and restarts in the last hour. Sort to put the noisiest first.',
    renderHeader: () => <SignalsHeader />,
    headerClassName: 'kubus-icon-header',
    width: 56,
    minWidth: 56,
    resizable: false,
    disableColumnMenu: true,
    align: 'center',
    headerAlign: 'center',
    type: 'number',
    // The first click puts the noisiest objects first.
    sortingOrder: ['desc', 'asc', null],
    valueGetter: (_v, row) => signalWeight(opts.signals?.(row.ctx, opts.signalKind ?? '', obj(row).metadata.namespace, obj(row).metadata.name, obj(row).metadata.uid)),
    renderCell: (params) => <SignalCell signal={opts.signals?.(params.row.ctx, opts.signalKind ?? '', obj(params.row).metadata.namespace, obj(params.row).metadata.name, obj(params.row).metadata.uid)} />,
  } satisfies Col),
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
  // The table sizes Name to its longest value (see ResourceTable); when it
  // still has to cut, the middle goes and the distinguishing end stays.
  name: () => ({
    field: 'name',
    headerName: 'Name',
    flex: 1.4,
    minWidth: 180,
    valueGetter: (_v, row) => obj(row).metadata.name,
    renderCell: (params) => <MiddleEllipsis text={obj(params.row).metadata.name} />,
  }),
  namespace: () => ({
    field: 'namespace',
    headerName: 'Namespace',
    width: 130,
    valueGetter: (_v, row) => obj(row).metadata.namespace ?? '',
  }),
  cluster: (opts) => ({
    field: 'cluster',
    headerName: 'Cluster',
    width: 118,
    valueGetter: (_v, row) => row.ctx,
    renderCell: (params) => <ClusterTag ctx={params.row.ctx} colorIndex={opts.clusterColors?.get(params.row.ctx) ?? 0} />,
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
    valueGetter: (_v, row) => podSummary(obj(row)).ready,
    renderCell: (params) => (
      <ReadyCounter
        value={String(params.value ?? '')}
        muted={/^(succeeded|completed)$/i.test(podSummary(obj(params.row)).status)}
      />
    ),
  }),
  podStatus: () => ({
    field: 'podStatus',
    headerName: 'Status',
    width: 150,
    valueGetter: (_v, row) => podSummary(obj(row)).status,
    renderCell: (params) => (
      <>
        <StatusChip status={podSummary(obj(params.row)).status} />
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
    valueGetter: (_v, row) => podSummary(obj(row)).restarts,
  }),
  node: () => ({
    field: 'node',
    headerName: 'Node',
    width: 150,
    valueGetter: (_v, row) => podSummary(obj(row)).node ?? '',
  }),
  cpu: (opts) => ({
    field: 'cpu',
    headerName: 'CPU',
    width: 120,
    type: 'number',
    headerAlign: 'left',
    align: 'left',
    ...metricsUnavailableHeader('CPU', opts.metricsUnavailable),
    valueGetter: (_v, row) => opts.metrics?.(row.ctx, obj(row).metadata.namespace, obj(row).metadata.name)?.cpuMilli ?? null,
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, obj(params.row).metadata.namespace, obj(params.row).metadata.name);
      if (!m) return missingMetric(params.row.ctx, opts.metricsUnavailable);
      // Workload lookups carry summed pod requests as capacity; Pod rows
      // read requests off their own spec.
      const max = m.cpuCapacityMilli ?? (podRequestTotals(obj(params.row)).cpuMilli || undefined);
      return <UsageMeter value={m.cpuMilli} max={max} format={formatCpu} placeholder emptyHint="no CPU requests set" />;
    },
  }),
  memory: (opts) => ({
    field: 'memory',
    headerName: 'Memory',
    width: 135,
    type: 'number',
    headerAlign: 'left',
    align: 'left',
    ...metricsUnavailableHeader('Memory', opts.metricsUnavailable),
    valueGetter: (_v, row) => opts.metrics?.(row.ctx, obj(row).metadata.namespace, obj(row).metadata.name)?.memBytes ?? null,
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, obj(params.row).metadata.namespace, obj(params.row).metadata.name);
      if (!m) return missingMetric(params.row.ctx, opts.metricsUnavailable);
      const max = m.memCapacityBytes ?? (podRequestTotals(obj(params.row)).memoryBytes || undefined);
      return <UsageMeter value={m.memBytes} max={max} format={formatBytes} placeholder emptyHint="no memory requests set" />;
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
      // Same count as the node's Pods tile: pods not yet finished, against the pods it accepts.
      const text = podCapacity ? `${summary.podCount} / ${podCapacity}` : String(summary.podCount);
      const split = summary.daemonSetPodCount ? `, ${summary.daemonSetPodCount} from DaemonSets` : '';
      return (
        <Tooltip title={`${summary.podCount} pods running or waiting${split}${podCapacity ? ` · ${podCapacity} allowed` : ''}`}>
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
    ...metricsUnavailableHeader('CPU Usage', opts.metricsUnavailable),
    valueGetter: (_v, row) => {
      const m = opts.metrics?.(row.ctx, undefined, obj(row).metadata.name);
      const capacity = m?.cpuCapacityMilli ?? nodeAllocatableCpuMilli(obj(row));
      return m && capacity ? (m.cpuMilli / capacity) * 100 : null;
    },
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, undefined, obj(params.row).metadata.name);
      if (!m && opts.metricsUnavailable?.includes(params.row.ctx)) return missingMetric(params.row.ctx, opts.metricsUnavailable);
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
    ...metricsUnavailableHeader('Memory Usage', opts.metricsUnavailable),
    valueGetter: (_v, row) => {
      const m = opts.metrics?.(row.ctx, undefined, obj(row).metadata.name);
      const capacity = m?.memCapacityBytes ?? nodeAllocatableMemoryBytes(obj(row));
      return m && capacity ? (m.memBytes / capacity) * 100 : null;
    },
    renderCell: (params) => {
      const m = opts.metrics?.(params.row.ctx, undefined, obj(params.row).metadata.name);
      if (!m && opts.metricsUnavailable?.includes(params.row.ctx)) return missingMetric(params.row.ctx, opts.metricsUnavailable);
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
  jobStatus: () => ({
    field: 'jobStatus',
    headerName: 'Status',
    width: 100,
    valueGetter: (_v, row) => jobPhase(obj(row)),
    renderCell: (params) => <StatusChip status={String(params.value ?? '')} />,
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
  jobOwner: () => ({
    field: 'jobOwner',
    headerName: 'Owner',
    width: 170,
    valueGetter: (_v, row) => {
      const ref = ownerReference(obj(row));
      return ref ? `${ref.kind}/${ref.name}` : '';
    },
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  cronSchedule: () => ({
    field: 'cronSchedule',
    headerName: 'Schedule',
    width: 150,
    valueGetter: (_v, row) => (obj(row).spec as { schedule?: string })?.schedule ?? '',
    renderCell: (params) => <ScheduleCell spec={obj(params.row).spec as { schedule?: string; timeZone?: string } | undefined} />,
  }),
  cronNextRun: () => ({
    field: 'cronNextRun',
    headerName: 'Next run',
    width: 95,
    type: 'number',
    headerAlign: 'left',
    align: 'left',
    valueGetter: (_v, row) => {
      const spec = obj(row).spec as { schedule?: string; suspend?: boolean; timeZone?: string } | undefined;
      if (!spec?.schedule || spec.suspend) return null;
      return cronNextRun(spec.schedule, spec.timeZone)?.getTime() ?? null;
    },
    renderCell: (params) =>
      typeof params.value === 'number' ? (
        <RelativeTimeCell timestamp={new Date(params.value).toISOString()} />
      ) : (
        <Typography variant="body2" color="text.disabled">
          —
        </Typography>
      ),
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
  nodeProviderID: () => ({
    field: 'nodeProviderID',
    headerName: 'Provider ID',
    width: 220,
    valueGetter: (_v, row) => ((obj(row).spec as { providerID?: string })?.providerID ?? ''),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  crdKind: () => ({
    field: 'crdKind',
    headerName: 'Kind',
    flex: 1,
    minWidth: 160,
    valueGetter: (_v, row) => (obj(row).spec as { names?: { kind?: string } })?.names?.kind ?? '',
  }),
  crdGroup: () => ({
    field: 'crdGroup',
    headerName: 'Group',
    flex: 1,
    minWidth: 170,
    valueGetter: (_v, row) => (obj(row).spec as { group?: string })?.group ?? '',
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  crdScope: () => ({
    field: 'crdScope',
    headerName: 'Scope',
    width: 105,
    valueGetter: (_v, row) => (obj(row).spec as { scope?: string })?.scope ?? '',
  }),
  crdVersions: () => ({
    field: 'crdVersions',
    headerName: 'Versions',
    description: 'Served versions; * marks the storage version',
    width: 120,
    valueGetter: (_v, row) => crdVersions(obj(row)),
    renderCell: (params) => <TextCell value={String(params.value ?? '')} />,
  }),
  crdStatus: () => ({
    field: 'crdStatus',
    headerName: 'Status',
    width: 105,
    valueGetter: (_v, row) => crdStatus(obj(row)),
    renderCell: (params) => <StatusChip status={String(params.value ?? '')} />,
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
    valueGetter: (_v, row) => eventFields(obj(row)).type,
    renderCell: (params) => <StatusChip status={eventFields(obj(params.row)).type ?? ''} />,
  }),
  eventReason: () => ({
    field: 'eventReason',
    headerName: 'Reason',
    width: 140,
    valueGetter: (_v, row) => eventFields(obj(row)).reason,
  }),
  eventObject: () => ({
    field: 'eventObject',
    headerName: 'Object',
    width: 220,
    valueGetter: (_v, row) => eventFields(obj(row)).object,
  }),
  eventMessage: () => ({
    field: 'eventMessage',
    headerName: 'Message',
    flex: 2,
    minWidth: 240,
    valueGetter: (_v, row) => eventFields(obj(row)).message,
  }),
  eventCount: () => ({
    field: 'eventCount',
    headerName: 'Count',
    width: 70,
    type: 'number',
    valueGetter: (_v, row) => eventFields(obj(row)).count,
  }),
  eventLastSeen: () => ({
    field: 'eventLastSeen',
    headerName: 'Last seen',
    width: 95,
    valueGetter: (_v, row) => eventFields(obj(row)).lastSeen ?? '',
    renderCell: (params) => <AgeCell timestamp={eventFields(obj(params.row)).lastSeen} />,
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
  hpaMetrics: () => ({
    field: 'hpaMetrics',
    headerName: 'Metrics',
    flex: 1.6,
    // Room for the usual pair: "cpu 42% / 60%, memory 15Mi / 64Mi".
    minWidth: 260,
    valueGetter: (_v, row) => hpaMetrics(obj(row)).map(hpaMetricText).join(', '),
    renderCell: (params) => {
      const metrics = hpaMetrics(obj(params.row));
      if (!metrics.length) {
        return (
          <Typography variant="body2" color="text.disabled">
            —
          </Typography>
        );
      }
      // One line per metric in the tooltip; the cell keeps them on one row.
      return (
        <Tooltip title={<Box sx={{ whiteSpace: 'pre-line' }}>{metrics.map(hpaMetricText).join('\n')}</Box>}>
          <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
            {metrics.map((m, i) => (
              <Box component="span" key={`${m.label}:${i}`}>
                {i > 0 && ', '}
                {m.label}{' '}
                <Box component="span" sx={{ fontWeight: 600, color: m.current === undefined ? 'text.disabled' : 'text.primary' }}>
                  {m.current ?? '?'}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary' }}>{` / ${m.target}`}</Box>
              </Box>
            ))}
          </Typography>
        </Tooltip>
      );
    },
  }),
  hpaReplicas: () => ({
    field: 'hpaReplicas',
    headerName: 'Replicas',
    width: 80,
    valueGetter: (_v, row) => ((obj(row).status as { currentReplicas?: number })?.currentReplicas ?? 0).toString(),
  }),
  hpaConditions: () => ({
    field: 'hpaConditions',
    headerName: 'Conditions',
    flex: 1,
    minWidth: 160,
    valueGetter: (_v, row) => hpaProblems(obj(row)),
    renderCell: (params) => {
      const text = String(params.value ?? '');
      return text ? (
        <Tooltip title={text}>
          <Typography variant="body2" noWrap sx={{ minWidth: 0, color: statusTextColor('warning') }}>
            {text}
          </Typography>
        </Tooltip>
      ) : (
        <Typography variant="body2" color="text.disabled">
          —
        </Typography>
      );
    },
  }),
};

function signalWeight(signal: ObjectSignal | undefined): number | null {
  if (!signal) return null;
  const warnings = signal.warnings.reduce((sum, w) => sum + w.count, 0);
  const restarts = (signal.restarts ?? []).reduce((sum, r) => sum + r.restarts, 0);
  return warnings + restarts || null;
}

function hasSignal(signal: ObjectSignal | undefined): signal is ObjectSignal {
  return !!signal && (signal.warnings.length > 0 || !!signal.restarts?.length);
}

function signalTitle(signal: ObjectSignal) {
  const warningTotal = signal.warnings.reduce((sum, w) => sum + w.count, 0);
  const lines = [
    ...signal.warnings.slice(0, 4).map((w) => `${w.reason}${w.count > 1 ? ` ×${w.count}` : ''}${w.total && w.total > w.count ? ` (${w.total} in its lifetime)` : ''}: ${w.message.length > 140 ? `${w.message.slice(0, 140)}…` : w.message}`),
    ...(signal.restarts ?? []).slice(0, 3).map((r) => `${r.container} restarted${r.reason ? ` (${r.reason})` : ''}${r.total && r.total > r.restarts ? `, ${r.total} times in its lifetime` : ''}`),
  ];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>
        {warningTotal ? `${warningTotal} warning event${warningTotal === 1 ? '' : 's'} in the last hour` : 'Restarted in the last hour'}
      </Typography>
      {lines.map((line, i) => (
        <Typography key={i} variant="caption" sx={{ display: 'block', wordBreak: 'break-word' }}>
          {line}
        </Typography>
      ))}
    </Box>
  );
}

function SignalIcon({ signal }: { signal: ObjectSignal }) {
  return (
    <Tooltip title={signalTitle(signal)} placement="right">
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: statusTextColor('warning'), cursor: 'help' }} aria-label={signal.warnings.length ? 'Recent warning events' : 'Recent restarts'}>
        {signal.warnings.length ? <WarningAmberRoundedIcon sx={{ fontSize: 16 }} /> : <ReplayRoundedIcon sx={{ fontSize: 16 }} />}
      </Box>
    </Tooltip>
  );
}

/**
 * The row marker: an amber triangle for recent warning events, a restart
 * arrow when only restarts happened. The tooltip carries the reasons, so
 * the answer to "what is wrong with this one" is a hover, not a click.
 */
function SignalCell({ signal }: { signal: ObjectSignal | undefined }) {
  return hasSignal(signal) ? <SignalIcon signal={signal} /> : null;
}

/** Header of the Warnings column: the marker glyph, named for screen readers. */
function SignalsHeader() {
  return (
    <Box component="span" aria-label="Warnings" sx={{ display: 'inline-flex', alignItems: 'center', color: 'text.secondary' }}>
      <WarningAmberRoundedIcon sx={{ fontSize: 16 }} />
    </Box>
  );
}

/**
 * Status-like columns that carry the warning marker for their row, so it
 * doesn't need a column of its own beside the name. CRD printer columns named
 * like a status (Ready, Phase, …) qualify too, unless they start hidden
 * (`hiddenFields`): a marker nobody sees is no marker.
 */
const SIGNAL_HOST_FIELDS = new Set(['podStatus', 'jobStatus', 'nodeStatus', 'pvcStatus', 'pvStatus', 'nsStatus', 'crdStatus', 'workloadReady', 'dsReady']);

export function signalHostField(columns: readonly Col[], hiddenFields: readonly string[] = []): string | undefined {
  return columns.find(
    (c) => !hiddenFields.includes(c.field) && (SIGNAL_HOST_FIELDS.has(c.field) || (c.field.startsWith('crd_') && statusLikeName(c.headerName ?? ''))),
  )?.field;
}

/**
 * Where the warning marker shows for a list whose kind has a status host
 * column. The dedicated Warnings column starts hidden while the host is
 * visible and carries the marker instead; showing Warnings (or hiding the
 * host) moves the marker there, so it never shows twice.
 */
export function signalPlacement(
  host: string | undefined,
  visibility: Readonly<Record<string, boolean>> | undefined,
  hiddenFields: readonly string[],
): { hostVisible: boolean; columnVisible: boolean; markerInHost: boolean } {
  const hostVisible = !!host && (visibility?.[host] ?? !hiddenFields.includes(host));
  const columnVisible = visibility?.[SIGNALS_COLUMN_ID] ?? !hostVisible;
  return { hostVisible, columnVisible, markerInHost: hostVisible && !columnVisible };
}

/** A status the cell already shows as a problem (red/amber, or fewer ready than wanted). */
function isProblemValue(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : '';
  const ready = /^(\d+)\/(\d+)$/.exec(text);
  if (ready) return Number(ready[1]) < Number(ready[2]);
  const tone = statusColor(text);
  return tone === 'error' || tone === 'warning';
}

/**
 * The warning marker folded into a status cell. When the status already
 * reads as a problem, the reasons ride on it as a tooltip (dotted underline
 * as the cue) instead of a second warning glyph; a healthy-looking status
 * with recent warnings or restarts gets the small marker after it.
 */
function SignalHost({ signal, problem, children }: { signal: ObjectSignal; problem: boolean; children: React.ReactNode }) {
  if (!problem) {
    return (
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        {children}
        <SignalIcon signal={signal} />
      </Box>
    );
  }
  return (
    <Tooltip title={signalTitle(signal)} placement="right">
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          minWidth: 0,
          cursor: 'help',
          textDecorationLine: 'underline',
          textDecorationStyle: 'dotted',
          textDecorationColor: 'currentColor',
          textUnderlineOffset: '3px',
          '& > *': { textDecoration: 'inherit' },
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

/** Wrap a status-like column so its cells carry the row's warning marker. */
export function withSignalMarker(column: Col, signals: SignalsLookup, signalKind: string): Col {
  const original = column.renderCell;
  return {
    ...column,
    renderCell: (params) => {
      const inner = original ? original(params) : String(params.formattedValue ?? params.value ?? '');
      const o = obj(params.row);
      const signal = signals(params.row.ctx, signalKind, o.metadata.namespace, o.metadata.name, o.metadata.uid);
      if (!hasSignal(signal)) return inner;
      return (
        <SignalHost signal={signal} problem={isProblemValue(params.value)}>
          {inner}
        </SignalHost>
      );
    },
  };
}

function metricsUnavailableHeader(name: string, contexts: readonly string[] | undefined): Partial<Col> {
  if (!contexts?.length) return {};
  return { renderHeader: () => <MetricsUnavailableHeader name={name} contexts={contexts} /> };
}

/** Column title plus a small ⓘ that says which clusters have no metrics. */
function MetricsUnavailableHeader({ name, contexts }: { name: string; contexts: readonly string[] }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
      <span className="MuiDataGrid-columnHeaderTitle">{name}</span>
      <Tooltip title={`metrics-server is not reachable in ${contexts.join(', ')}, so rows from ${contexts.length === 1 ? 'that cluster' : 'those clusters'} have no ${name} figures.`}>
        <InfoOutlinedIcon aria-label={`${name} unavailable in ${contexts.join(', ')}`} sx={{ fontSize: 14, color: 'info.main', cursor: 'help' }} />
      </Tooltip>
    </Box>
  );
}

function missingMetric(ctx: string, unavailable: readonly string[] | undefined) {
  if (!unavailable?.includes(ctx)) return '—';
  return (
    <Tooltip title={`metrics-server is not reachable in ${ctx}`}>
      <Typography variant="body2" color="text.disabled" sx={{ cursor: 'help' }}>
        —
      </Typography>
    </Tooltip>
  );
}

/**
 * Lookup over the per-context signal maps, keyed exactly like the server
 * builds them. Given the row's uid, warnings recorded against an earlier
 * object of the same name (a recreated StatefulSet pod) are left out.
 */
export function makeSignalsLookup(signals: Map<string, ClusterSignals> | undefined): SignalsLookup | undefined {
  if (!signals || signals.size === 0) return undefined;
  return (ctx, kind, namespace, name, uid) => {
    const signal = signals.get(ctx)?.objects[`${kind}|${namespace ?? ''}|${name}`];
    if (!signal || !uid) return signal;
    const warnings = signal.warnings.filter((w) => !w.uid || w.uid === uid);
    if (warnings.length === signal.warnings.length) return signal;
    return warnings.length || signal.restarts?.length ? { ...signal, warnings } : undefined;
  };
}

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
    return onLabelClick ? (
      <button type="button" key={key} className="kubus-label-chip" onClick={event => { event.stopPropagation(); onLabelClick(term); }}>{term}</button>
    ) : <span key={key} className="kubus-label-chip">{term}</span>;
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
        <span className="kubus-labels-tooltip">{entries.map(chip)}</span>
      }
    >
      <span className="kubus-labels-cell">
        {visible.map(chip)}
        {overflow > 0 && <span className="kubus-label-chip kubus-label-overflow">+{overflow}</span>}
      </span>
    </Tooltip>
  );
}

/**
 * CronJob schedule, shown as the cron expression or its human-readable text.
 * Clicking flips the (persisted) preference for every schedule cell at once.
 */
function ScheduleCell({ spec }: { spec?: { schedule?: string; timeZone?: string } }) {
  const human = useUiPrefsStore((s) => s.cronHumanSchedule);
  const schedule = spec?.schedule ?? '';
  if (!schedule) return null;
  const humanText = cronHumanText(schedule);
  const shown = human && humanText ? humanText : schedule;
  const alt = human && humanText ? schedule : humanText;
  const hint = [alt, spec?.timeZone, 'click to toggle'].filter(Boolean).join(' — ');
  return (
    <Tooltip title={hint}>
      <Typography
        variant="body2"
        noWrap
        onClick={(event) => {
          event.stopPropagation();
          useUiPrefsStore.getState().set({ cronHumanSchedule: !human });
        }}
        sx={{ cursor: 'pointer', minWidth: 0 }}
      >
        {shown}
      </Typography>
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

interface NodeAllocatable {
  cpuMilli: number;
  memoryBytes: number;
  pods: number;
}

// Five node columns each parse allocatable quantities in both valueGetter and
// renderCell; cache per object so a row parses its quantities once.
const nodeAllocatableCache = new WeakMap<KubeObject, NodeAllocatable>();

function nodeAllocatable(node: KubeObject): NodeAllocatable {
  let alloc = nodeAllocatableCache.get(node);
  if (!alloc) {
    const raw = (node.status as { allocatable?: Record<string, string> } | undefined)?.allocatable;
    alloc = {
      cpuMilli: Math.round(parseQuantity(raw?.cpu) * 1000),
      memoryBytes: Math.round(parseQuantity(raw?.memory)),
      pods: Math.round(parseQuantity(raw?.pods)),
    };
    nodeAllocatableCache.set(node, alloc);
  }
  return alloc;
}

function nodeAllocatableCpuMilli(node: KubeObject): number {
  return nodeAllocatable(node).cpuMilli;
}

function nodeAllocatableMemoryBytes(node: KubeObject): number {
  return nodeAllocatable(node).memoryBytes;
}

function nodeAllocatablePods(node: KubeObject): number {
  return nodeAllocatable(node).pods;
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
 * the column's jsonPath against the live object; lists are joined, other
 * non-scalar results are stringified and truncated. Fields are prefixed to avoid clashing with
 * preset column ids.
 */
export function buildCrdColumns(cols: PrinterColumn[]): Col[] {
  return cols.map((c, i): Col => {
    const numeric = c.type === 'integer' || c.type === 'number';
    const statusLike = statusLikeName(c.name);
    // The JSONPath walk runs in valueGetter and again in renderCell, per row
    // per grid pass; cache per object identity (watch updates replace objects).
    const valueCache = new WeakMap<KubeObject, unknown>();
    const value = (row: ClusterRow): unknown => {
      if (valueCache.has(row.obj)) return valueCache.get(row.obj);
      const v = evalPrinterColumnPath(row.obj, c.jsonPath);
      valueCache.set(row.obj, v);
      return v;
    };
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
        // Lists (a Hostnames column on `.spec.hostnames`) read as a joined list.
        if (typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v).slice(0, 200);
        return printerColumnText(v) ?? '';
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

/** Kinds whose list CPU/Memory columns aggregate the usage of their pods. */
export const WORKLOAD_METRIC_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);

/**
 * Aggregate per-pod usage up to the owning workload so Deployment/StatefulSet/
 * DaemonSet/ReplicaSet lists can show CPU/Memory. Pods are attributed via
 * their controller ownerReference; Deployment pods are owned by a ReplicaSet
 * named `<deployment>-<pod-template-hash>`, so the Deployment name is
 * recovered by stripping that suffix.
 */
export function makeWorkloadMetricsLookup(kind: string, pods: ClusterRow[], metrics: Map<string, MetricsSnapshot> | undefined): MetricsLookup | undefined {
  const podMetrics = makeMetricsLookup('Pod', metrics);
  if (!podMetrics || !WORKLOAD_METRIC_KINDS.has(kind)) return undefined;
  const totals = new Map<string, { cpuMilli: number; memBytes: number; cpuRequestMilli: number; memRequestBytes: number }>();
  for (const row of pods) {
    const owner = workloadOwnerName(kind, row.obj);
    if (!owner) continue;
    const usage = podMetrics(row.ctx, row.obj.metadata.namespace, row.obj.metadata.name);
    if (!usage) continue;
    const key = `${row.ctx}\0${row.obj.metadata.namespace ?? ''}\0${owner}`;
    // Requests are summed over the same pods the usage came from, so the
    // usage bar's denominator matches its numerator.
    const requests = podRequestTotals(row.obj);
    const prev = totals.get(key);
    if (prev) {
      prev.cpuMilli += usage.cpuMilli;
      prev.memBytes += usage.memBytes;
      prev.cpuRequestMilli += requests.cpuMilli;
      prev.memRequestBytes += requests.memoryBytes;
    } else {
      totals.set(key, { cpuMilli: usage.cpuMilli, memBytes: usage.memBytes, cpuRequestMilli: requests.cpuMilli, memRequestBytes: requests.memoryBytes });
    }
  }
  return (ctx, namespace, name) => {
    const t = totals.get(`${ctx}\0${namespace ?? ''}\0${name}`);
    return t
      ? { cpuMilli: t.cpuMilli, memBytes: t.memBytes, cpuCapacityMilli: t.cpuRequestMilli || undefined, memCapacityBytes: t.memRequestBytes || undefined }
      : undefined;
  };
}

function workloadOwnerName(kind: string, pod: KubeObject): string | undefined {
  const owner = (pod.metadata.ownerReferences ?? []).find((o) => o.controller);
  if (!owner) return undefined;
  if (kind === 'Deployment') {
    if (owner.kind !== 'ReplicaSet') return undefined;
    const hash = pod.metadata.labels?.['pod-template-hash'];
    return hash && owner.name.endsWith(`-${hash}`) ? owner.name.slice(0, -(hash.length + 1)) : undefined;
  }
  return owner.kind === kind ? owner.name : undefined;
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
