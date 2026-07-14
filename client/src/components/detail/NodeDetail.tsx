import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { GenericDetail, ConditionsTable } from './GenericDetail.js';
import { PodMiniList } from './PodMiniList.js';
import { StatusChip } from '../StatusChip.js';
import { formatBytes } from '../format.js';
import { nodeRoles, nodeStatus, parseQuantity } from '../../kube-display.js';
import { useResourceList } from '../../api/queries.js';

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
  const podsQuery = useResourceList({ ctx, group: '', version: 'v1', plural: 'pods', fieldSelector: `spec.nodeName=${name}` });

  const resourceKeys = ['cpu', 'memory', 'pods', 'ephemeral-storage'].filter((k) => status.capacity?.[k] !== undefined || status.allocatable?.[k] !== undefined);

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ px: 2, pt: 2, flexWrap: 'wrap' }}>
        <StatusChip status={nodeStatus(obj)} />
        {roles && <Chip label={roles} variant="outlined" />}
        {status.nodeInfo?.kubeletVersion && <Chip label={status.nodeInfo.kubeletVersion} variant="outlined" />}
        {status.nodeInfo?.osImage && <Chip label={status.nodeInfo.osImage} variant="outlined" />}
        {status.nodeInfo?.architecture && <Chip label={status.nodeInfo.architecture} variant="outlined" />}
        {status.nodeInfo?.containerRuntimeVersion && <Chip label={status.nodeInfo.containerRuntimeVersion} variant="outlined" />}
      </Stack>
      <Stack spacing={2} sx={{ px: 2, pt: 2 }}>
        {!!status.addresses?.length && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Addresses
            </Typography>
            <Table size="small">
              <TableBody>
                {status.addresses.map((a) => (
                  <TableRow key={`${a.type}:${a.address}`}>
                    <TableCell sx={{ width: 140, color: 'text.secondary', border: 0 }}>{a.type}</TableCell>
                    <TableCell sx={{ border: 0 }}>{a.address}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
        {resourceKeys.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Capacity
            </Typography>
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
          </Box>
        )}
        <ConditionsTable obj={obj} goodWhen={nodeGoodWhen} />
        <Divider />
        <PodMiniList ctx={ctx} pods={podsQuery.data?.items ?? []} title="Pods on this node" loading={podsQuery.isLoading} />
      </Stack>
      <GenericDetail obj={obj} ctx={ctx} hideConditions />
    </Box>
  );
}
