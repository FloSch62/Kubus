import type { GridColDef } from '@mui/x-data-grid';
import { Tooltip } from '@mui/material';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import { evalPrinterColumnPath, type KubeObject, type MetricsSnapshot, type PrinterColumn } from '@kubus/shared';
import type { ClusterRow } from '../api/queries.js';
import { AgeCell } from './AgeCell.js';
import { StatusChip } from './StatusChip.js';
import { formatBytes, formatCpu } from './Sparkline.js';
import { dataKeyCount, eventFields, hasRunningDebugContainer, ingressHosts, jobStatus, nodeRoles, nodeStatus, podSummary, servicePorts, workloadReady } from '../kube-display.js';

export type MetricsLookup = (ctx: string, namespace: string | undefined, name: string) => { cpuMilli: number; memBytes: number } | undefined;

type Col = GridColDef<ClusterRow>;

function obj(row: ClusterRow): KubeObject {
  return row.obj;
}

/** Build DataGrid column definitions from semantic column ids. */
export function buildColumns(columnIds: string[], opts: { multiCluster: boolean; metrics?: MetricsLookup }): Col[] {
  const cols: Col[] = [];
  for (const id of columnIds) {
    if (id === 'cluster' && !opts.multiCluster) continue;
    const col = COLUMN_DEFS[id]?.(opts);
    if (col) cols.push(col);
  }
  return cols;
}

const COLUMN_DEFS: Record<string, (opts: { metrics?: MetricsLookup }) => Col> = {
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
    valueGetter: (_v, row) => podSummary(obj(row)).ready,
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
  workloadReady: () => ({
    field: 'workloadReady',
    headerName: 'Ready',
    width: 80,
    valueGetter: (_v, row) => workloadReady(obj(row)),
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
    headerName: 'Version',
    width: 130,
    valueGetter: (_v, row) => ((obj(row).status as { nodeInfo?: { kubeletVersion?: string } })?.nodeInfo?.kubeletVersion ?? ''),
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
    renderCell: (params) => <StatusChip status={eventFields(obj(params.row)).type === 'Warning' ? 'Error' : 'Ready'} />,
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
  hpaReplicas: () => ({
    field: 'hpaReplicas',
    headerName: 'Replicas',
    width: 80,
    valueGetter: (_v, row) => ((obj(row).status as { currentReplicas?: number })?.currentReplicas ?? 0).toString(),
  }),
};

/**
 * Columns from a CRD's additionalPrinterColumns. Values come from evaluating
 * the column's jsonPath against the live object; non-scalar results are
 * stringified and truncated. Fields are prefixed to avoid clashing with
 * preset column ids.
 */
export function buildCrdColumns(cols: PrinterColumn[]): Col[] {
  return cols.map((c, i): Col => {
    const numeric = c.type === 'integer' || c.type === 'number';
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
        return String(v);
      },
      renderCell: c.type === 'date' ? (params) => <AgeCell timestamp={(value(params.row) as string | undefined) || undefined} /> : undefined,
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
  return (ctx, namespace, name) => {
    const snap = metrics.get(ctx);
    if (!snap?.available) return undefined;
    const entry = snap.items.find((i) => i.name === name && (kind === 'Node' || i.namespace === namespace));
    return entry ? { cpuMilli: entry.cpuMilli, memBytes: entry.memBytes } : undefined;
  };
}
