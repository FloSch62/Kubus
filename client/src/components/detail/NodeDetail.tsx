import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import type { KubeObject } from '@kubus/shared';
import { GenericDetail, ConditionsTable, hasUnhealthyCondition } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { PodMiniList } from './PodMiniList.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { CopyValueButton } from '../CellCopy.js';
import { formatBytes } from '../format.js';
import { nodeRoles, parseQuantity, podSummary } from '../../kube-display.js';
import { DETAIL_LIST_LIVE_MS, useResourceList } from '../../api/queries.js';

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

export function NodeDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const status = (obj.status ?? {}) as NodeStatus;
  const name = obj.metadata.name;
  const roles = nodeRoles(obj);
  const spec = obj.spec as { providerID?: string; podCIDR?: string; podCIDRs?: string[]; taints?: Array<{ key: string; value?: string; effect: string }> } | undefined;
  const podsQuery = useResourceList({ ctx, group: '', version: 'v1', plural: 'pods', fieldSelector: `spec.nodeName=${name}` }, { liveMs: DETAIL_LIST_LIVE_MS });
  const pods = podsQuery.data?.items ?? [];
  const runningPods = pods.filter((p) => podSummary(p).status === 'Running').length;
  const unhealthy = hasUnhealthyCondition(obj, nodeGoodWhen);

  const resourceKeys = ['cpu', 'memory', 'pods', 'ephemeral-storage'].filter((k) => status.capacity?.[k] !== undefined || status.allocatable?.[k] !== undefined);
  const internalIp = status.addresses?.find((a) => a.type === 'InternalIP')?.address;

  return (
    <Box>
      <DetailStack sx={{ pb: 0 }}>
        <SummaryStrip
          items={[
            { label: 'Roles', value: roles || 'worker', span: 2 },
            { label: 'Pods', value: podsQuery.isLoading ? '…' : `${runningPods}/${pods.length}`, hint: 'Running pods out of all pods scheduled on this node.' },
            { label: 'Kubelet', value: status.nodeInfo?.kubeletVersion },
            { label: 'Conditions', value: unhealthy ? 'Degraded' : 'Healthy', tone: unhealthy ? 'warning' : 'success' },
          ]}
        />
        <Section title="System">
          <Facts>
            <Fact label="OS">{status.nodeInfo?.osImage}</Fact>
            <Fact label="Architecture">{status.nodeInfo?.architecture}</Fact>
            <Fact label="Runtime">{status.nodeInfo?.containerRuntimeVersion}</Fact>
            <Fact label="Kernel">{status.nodeInfo?.kernelVersion}</Fact>
            <Fact label="Internal IP" mono>
              {internalIp}
            </Fact>
            <Fact label="Pod CIDR" mono>
              {(spec?.podCIDRs?.length ? spec.podCIDRs : spec?.podCIDR ? [spec.podCIDR] : []).join(', ')}
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
        {resourceKeys.length > 0 && (
          <Section title="Capacity" flush>
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
        <Section title="Pods on this node" count={podsQuery.isLoading ? undefined : pods.length} flush>
          <PodMiniList ctx={ctx} pods={pods} loading={podsQuery.isLoading} />
        </Section>
      </DetailStack>
      <GenericDetail obj={obj} ctx={ctx} hideConditions />
    </Box>
  );
}
