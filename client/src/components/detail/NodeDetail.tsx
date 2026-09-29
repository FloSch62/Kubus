import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { GenericDetail, ConditionsTable, hasUnhealthyCondition } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { PodMiniList, daemonSetOwner } from './PodMiniList.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { CopyValueButton } from '../CellCopy.js';
import { UsageMeter } from '../UsageMeter.js';
import { formatBytes, formatCpu } from '../format.js';
import { nodeRoles, parseQuantity, podRequestTotals } from '../../kube-display.js';
import { DETAIL_LIST_LIVE_MS, useResourceList, useResourceMetrics } from '../../api/queries.js';

interface NodeStatus {
  addresses?: Array<{ type: string; address: string }>;
  capacity?: Record<string, string>;
  allocatable?: Record<string, string>;
  nodeInfo?: { kubeletVersion?: string; osImage?: string; architecture?: string; containerRuntimeVersion?: string; kernelVersion?: string };
}

// Node conditions are inverted: pressure/unavailability conditions are
// healthy when False; only Ready is healthy when True.
const nodeGoodWhen = (type: string): 'True' | 'False' => (type === 'Ready' ? 'True' : 'False');

function formatResource(key: string, value: string | undefined): string {
  if (value === undefined) return '';
  if (key === 'memory' || key === 'ephemeral-storage') return formatBytes(parseQuantity(value));
  return value;
}

/**
 * Pods that occupy the node: everything not finished. Completed Job pods
 * keep their node name but hold no resources and no pod slot, so the list,
 * the Pods tile and the Nodes list all count the same set.
 */
export function isActiveNodePod(pod: KubeObject): boolean {
  const phase = (pod.status as { phase?: string } | undefined)?.phase;
  return phase !== 'Succeeded' && phase !== 'Failed';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Readable "12" / "0.5" cores for the allocatable column. */
function coresText(milli: number): string {
  return milli % 1000 === 0 ? `${milli / 1000} cores` : formatCpu(milli);
}

function AllocationRow({
  label,
  requested,
  used,
  allocatable,
  format,
  usedHint,
}: {
  label: string;
  requested?: number;
  used?: number;
  allocatable: number;
  format: (v: number) => string;
  usedHint?: string;
}) {
  return (
    <TableRow>
      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</TableCell>
      <TableCell sx={{ minWidth: 140 }}>
        {requested === undefined ? (
          <Typography variant="body2" color="text.secondary">
            —
          </Typography>
        ) : allocatable ? (
          <UsageMeter value={requested} max={allocatable} format={format} maxHint="allocatable" />
        ) : (
          format(requested)
        )}
      </TableCell>
      <TableCell sx={{ minWidth: 140 }}>
        {used === undefined ? (
          <Typography variant="body2" color="text.secondary" title={usedHint}>
            —
          </Typography>
        ) : allocatable ? (
          <UsageMeter value={used} max={allocatable} format={format} maxHint="allocatable" />
        ) : (
          format(used)
        )}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        {allocatable ? format(allocatable) : '—'}
      </TableCell>
    </TableRow>
  );
}

export function NodeDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const status = (obj.status ?? {}) as NodeStatus;
  const name = obj.metadata.name;
  const roles = nodeRoles(obj);
  const spec = obj.spec as { providerID?: string; podCIDR?: string; podCIDRs?: string[]; taints?: Array<{ key: string; value?: string; effect: string }> } | undefined;
  const podsQuery = useResourceList({ ctx, group: '', version: 'v1', plural: 'pods', fieldSelector: `spec.nodeName=${name}` }, { liveMs: DETAIL_LIST_LIVE_MS });
  const pods = podsQuery.data?.items;
  const activePods = useMemo(() => (pods ?? []).filter(isActiveNodePod), [pods]);
  const finishedPods = (pods?.length ?? 0) - activePods.length;
  // DaemonSet pods come with the node; the rest were scheduled onto it.
  const daemonPods = activePods.filter((p) => daemonSetOwner(p)).length;
  const unhealthy = hasUnhealthyCondition(obj, nodeGoodWhen);
  const metricsQuery = useResourceMetrics([ctx], 'nodes');
  const snapshot = metricsQuery.data?.get(ctx);
  const usage = snapshot?.available ? snapshot.items.find((i) => i.name === name) : undefined;

  const allocatable = status.allocatable ?? {};
  const allocCpu = allocatable.cpu ? Math.round(parseQuantity(allocatable.cpu) * 1000) : 0;
  const allocMemory = allocatable.memory ? parseQuantity(allocatable.memory) : 0;
  const allocPods = allocatable.pods ? parseQuantity(allocatable.pods) : 0;
  const requests = useMemo(
    () =>
      activePods.reduce(
        (sum, pod) => {
          const r = podRequestTotals(pod);
          return { cpuMilli: sum.cpuMilli + r.cpuMilli, memoryBytes: sum.memoryBytes + r.memoryBytes };
        },
        { cpuMilli: 0, memoryBytes: 0 },
      ),
    [activePods],
  );

  const resourceKeys = ['cpu', 'memory', 'pods', 'ephemeral-storage'].filter((k) => status.capacity?.[k] !== undefined || status.allocatable?.[k] !== undefined);
  // Capacity only differs from allocatable when the kubelet reserves some for
  // the system; otherwise the table repeats one column twice.
  const reserved = resourceKeys.some((k) => parseQuantity(status.capacity?.[k] ?? '0') !== parseQuantity(status.allocatable?.[k] ?? '0'));
  const internalIp = status.addresses?.find((a) => a.type === 'InternalIP')?.address;
  const podCidrs = spec?.podCIDRs?.length ? spec.podCIDRs : spec?.podCIDR ? [spec.podCIDR] : [];
  const systemSummary = [status.nodeInfo?.osImage, status.nodeInfo?.architecture, status.nodeInfo?.containerRuntimeVersion, podCidrs.join(', ')].filter(Boolean).join(' · ');
  const loading = podsQuery.isLoading;

  return (
    <Box>
      <DetailStack sx={{ pb: 0 }}>
        <SummaryStrip
          items={[
            { label: 'Roles', value: roles || 'worker', span: 2 },
            {
              label: 'Pods',
              value: loading ? '…' : allocPods ? `${activePods.length} / ${allocPods}` : String(activePods.length),
              hint: 'Pods running or waiting on this node, out of the most it accepts. Finished pods hold no slot.',
              detail: finishedPods ? `+${finishedPods} finished` : undefined,
            },
            { label: 'Kubelet', value: status.nodeInfo?.kubeletVersion },
            { label: 'Conditions', value: unhealthy ? 'Degraded' : 'Healthy', tone: unhealthy ? 'warning' : 'success' },
          ]}
        />
        {(allocCpu > 0 || allocMemory > 0 || allocPods > 0) && (
          <Section
            title="Allocation"
            flush
            description={reserved ? 'of allocatable' : 'of allocatable · nothing is reserved for the system'}
          >
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Resource</TableCell>
                  <TableCell>Requested</TableCell>
                  <TableCell>Used</TableCell>
                  <TableCell align="right">Allocatable</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {allocCpu > 0 && (
                  <AllocationRow
                    label="CPU"
                    requested={requests.cpuMilli}
                    used={usage?.cpuMilli}
                    allocatable={allocCpu}
                    format={(v) => (v === allocCpu ? coresText(v) : formatCpu(v))}
                    usedHint="No usage data: metrics-server is not reachable"
                  />
                )}
                {allocMemory > 0 && (
                  <AllocationRow
                    label="Memory"
                    requested={requests.memoryBytes}
                    used={usage?.memBytes}
                    allocatable={allocMemory}
                    format={formatBytes}
                    usedHint="No usage data: metrics-server is not reachable"
                  />
                )}
                {allocPods > 0 && <AllocationRow label="Pods" used={activePods.length} allocatable={allocPods} format={String} />}
              </TableBody>
            </Table>
          </Section>
        )}
        <Section title="System" defaultOpen={false} description={systemSummary || undefined}>
          <Facts>
            <Fact label="OS">{status.nodeInfo?.osImage}</Fact>
            <Fact label="Architecture">{status.nodeInfo?.architecture}</Fact>
            <Fact label="Runtime">{status.nodeInfo?.containerRuntimeVersion}</Fact>
            <Fact label="Kernel">{status.nodeInfo?.kernelVersion}</Fact>
            <Fact label="Internal IP" mono>
              {internalIp}
            </Fact>
            <Fact label="Pod CIDR" mono>
              {podCidrs.join(', ')}
            </Fact>
            <Fact label="Taints">
              {spec?.taints?.map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`).join(', ')}
            </Fact>
          </Facts>
        </Section>
        {(!!status.addresses?.length || spec?.providerID) && (
          <Section title="Addresses" defaultOpen={false} description={status.addresses?.map((a) => a.address).join(', ')}>
            <Facts>
              {(status.addresses ?? []).map((a) => (
                <Fact key={`${a.type}:${a.address}`} label={a.type}>
                  {a.address}
                </Fact>
              ))}
              <Fact label="Provider ID" mono>
                {spec?.providerID && (
                  <>
                    {spec.providerID} <CopyValueButton text={spec.providerID} label="Copy provider ID" />
                  </>
                )}
              </Fact>
            </Facts>
          </Section>
        )}
        {reserved && resourceKeys.length > 0 && (
          <Section title="Capacity" flush description="some capacity is reserved for the system">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Resource</TableCell>
                  <TableCell>Capacity</TableCell>
                  <TableCell>Allocatable</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {resourceKeys.map((k) => (
                  <TableRow key={k}>
                    <TableCell>{k}</TableCell>
                    <TableCell>{formatResource(k, status.capacity?.[k])}</TableCell>
                    <TableCell>{formatResource(k, status.allocatable?.[k])}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        )}
        <ConditionsTable obj={obj} goodWhen={nodeGoodWhen} defaultOpen={unhealthy} />
        <Section
          title="Pods on this node"
          count={loading ? undefined : activePods.length}
          flush
          description={
            loading
              ? undefined
              : [daemonPods ? `${daemonPods} from DaemonSet${daemonPods === 1 ? '' : 's'}` : undefined, finishedPods ? `${plural(finishedPods, 'finished pod')} not shown` : undefined]
                  .filter(Boolean)
                  .join(' · ') || undefined
          }
        >
          <PodMiniList ctx={ctx} pods={activePods} loading={loading} daemonSets />
        </Section>
      </DetailStack>
      <GenericDetail obj={obj} ctx={ctx} hideConditions />
    </Box>
  );
}
