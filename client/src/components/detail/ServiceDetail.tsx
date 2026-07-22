import { useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CableIcon from '@mui/icons-material/Cable';
import type { KubeObject } from '@kubus/shared';
import { GenericDetail, KeyValueSection } from './GenericDetail.js';
import { PodMiniList } from './PodMiniList.js';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { Section } from './Section.js';
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
  const [forwardPort, setForwardPort] = useState<number>();
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
          <Section title="Ports" count={spec.ports.length}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {spec.ports.some((p) => p.name) && <TableCell>Name</TableCell>}
                  <TableCell>Port</TableCell>
                  <TableCell>Target</TableCell>
                  {spec.ports.some((p) => p.nodePort !== undefined) && <TableCell>NodePort</TableCell>}
                  <TableCell>Protocol</TableCell>
                  <TableCell padding="none" />
                </TableRow>
              </TableHead>
              <TableBody>
                {spec.ports.map((p, i) => (
                  <TableRow key={p.name ?? i}>
                    {spec.ports!.some((q) => q.name) && <TableCell>{p.name ?? ''}</TableCell>}
                    <TableCell>{p.port}</TableCell>
                    <TableCell>{p.targetPort ?? p.port}</TableCell>
                    {spec.ports!.some((q) => q.nodePort !== undefined) && <TableCell>{p.nodePort ?? ''}</TableCell>}
                    <TableCell>{p.protocol ?? 'TCP'}</TableCell>
                    <TableCell padding="none" align="right">
                      {(p.protocol ?? 'TCP') === 'TCP' && (
                        <Tooltip title={`Forward port ${p.port}`}>
                          <IconButton size="small" aria-label={`Forward port ${p.port}`} onClick={() => setForwardPort(p.port)}>
                            <CableIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        )}
        {labelSelector ? (
          <>
            <KeyValueSection title="Selector" entries={selector} />
            <Section title="Matching pods" count={podsQuery.isLoading ? undefined : (podsQuery.data?.items ?? []).length}>
              <PodMiniList ctx={ctx} pods={podsQuery.data?.items ?? []} loading={podsQuery.isLoading} emptyText="No pods match the selector." hideNamespace />
            </Section>
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No selector — endpoints for this Service are managed manually or it is headless/ExternalName.
          </Typography>
        )}
      </Stack>
      <GenericDetail obj={obj} ctx={ctx} />
      {forwardPort !== undefined && (
        <PortForwardDialog ctx={ctx} kind="Service" obj={obj} initialRemotePort={forwardPort} onClose={() => setForwardPort(undefined)} />
      )}
    </Box>
  );
}
