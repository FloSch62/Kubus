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
import { GenericDetail, KeyValueChips } from './GenericDetail.js';
import { PodMiniList } from './PodMiniList.js';
import { useResourceList } from '../../api/queries.js';

interface ServiceSpec {
  type?: string;
  clusterIP?: string;
  externalIPs?: string[];
  selector?: Record<string, string>;
  ports?: Array<{ name?: string; port: number; targetPort?: number | string; nodePort?: number; protocol?: string }>;
}

interface ServiceStatus {
  loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> };
}

export function ServiceDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = (obj.spec ?? {}) as ServiceSpec;
  const status = (obj.status ?? {}) as ServiceStatus;
  const lbAddresses = (status.loadBalancer?.ingress ?? []).flatMap((i) => {
    const addr = i.ip ?? i.hostname;
    return addr ? [addr] : [];
  });
  const selector = spec.selector ?? {};
  const labelSelector = Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const podsQuery = useResourceList(
    labelSelector ? { ctx, group: '', version: 'v1', plural: 'pods', namespace: obj.metadata.namespace, labelSelector } : undefined,
  );

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ px: 2, pt: 2, flexWrap: 'wrap' }}>
        {spec.type && <Chip label={spec.type} variant="outlined" color="primary" />}
        {spec.clusterIP && <Chip label={`ClusterIP ${spec.clusterIP}`} variant="outlined" />}
        {(spec.externalIPs ?? []).map((ip) => (
          <Chip key={ip} label={`External ${ip}`} variant="outlined" />
        ))}
        {lbAddresses.map((addr) => (
          <Chip key={addr} label={`LB ${addr}`} variant="outlined" />
        ))}
      </Stack>
      <Stack spacing={2} sx={{ px: 2, pt: 2 }}>
        {!!spec.ports?.length && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Ports
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Port</TableCell>
                  <TableCell>Target</TableCell>
                  <TableCell>NodePort</TableCell>
                  <TableCell>Protocol</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {spec.ports.map((p, i) => (
                  <TableRow key={p.name ?? i}>
                    <TableCell>{p.name ?? ''}</TableCell>
                    <TableCell>{p.port}</TableCell>
                    <TableCell>{p.targetPort ?? p.port}</TableCell>
                    <TableCell>{p.nodePort ?? ''}</TableCell>
                    <TableCell>{p.protocol ?? 'TCP'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
        {labelSelector ? (
          <>
            <KeyValueChips title="Selector" entries={selector} />
            <Divider />
            <PodMiniList ctx={ctx} pods={podsQuery.data?.items ?? []} title="Matching pods" loading={podsQuery.isLoading} emptyText="No pods match the selector." />
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No selector — endpoints for this Service are managed manually or it is headless/ExternalName.
          </Typography>
        )}
      </Stack>
      <GenericDetail obj={obj} ctx={ctx} />
    </Box>
  );
}
