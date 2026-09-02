import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CableIcon from '@mui/icons-material/Cable';
import type { KubeObject } from '@kubus/shared';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { PodMiniList } from './PodMiniList.js';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { ProblemBanner } from './ProblemBanner.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { CopyValueButton } from '../CellCopy.js';
import { StatusChip } from '../StatusChip.js';
import { useResourceList } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';

interface ServicePort {
  name?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
  protocol?: string;
  appProtocol?: string;
}

interface ServiceSpec {
  type?: string;
  clusterIP?: string;
  clusterIPs?: string[];
  externalIPs?: string[];
  externalName?: string;
  sessionAffinity?: string;
  sessionAffinityConfig?: { clientIP?: { timeoutSeconds?: number } };
  externalTrafficPolicy?: string;
  internalTrafficPolicy?: string;
  ipFamilies?: string[];
  ipFamilyPolicy?: string;
  healthCheckNodePort?: number;
  publishNotReadyAddresses?: boolean;
  loadBalancerClass?: string;
  selector?: Record<string, string>;
  ports?: ServicePort[];
}

interface ServiceStatus {
  loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> };
}

interface EndpointSliceShape {
  addressType?: string;
  endpoints?: Array<{
    addresses?: string[];
    conditions?: { ready?: boolean; serving?: boolean; terminating?: boolean };
    targetRef?: { kind?: string; name?: string; namespace?: string };
    nodeName?: string;
    zone?: string;
  }>;
}

interface EndpointRow {
  address: string;
  state: 'Ready' | 'NotReady' | 'Terminating';
  pod?: string;
  node?: string;
}

/** Flattened endpoints across the Service's slices, problems first. */
export function endpointRows(slices: KubeObject[]): EndpointRow[] {
  const rows: EndpointRow[] = [];
  for (const slice of slices) {
    for (const ep of (slice as unknown as EndpointSliceShape).endpoints ?? []) {
      const state: EndpointRow['state'] = ep.conditions?.terminating ? 'Terminating' : ep.conditions?.ready === false ? 'NotReady' : 'Ready';
      rows.push({
        address: (ep.addresses ?? []).join(', '),
        state,
        pod: ep.targetRef?.kind === 'Pod' ? ep.targetRef.name : undefined,
        node: ep.nodeName,
      });
    }
  }
  const rank = { NotReady: 0, Terminating: 1, Ready: 2 };
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || a.address.localeCompare(b.address));
}

export function ServiceDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const [forwardPort, setForwardPort] = useState<number>();
  const push = useDetailStore((s) => s.push);
  const spec = (obj.spec ?? {}) as ServiceSpec;
  const status = (obj.status ?? {}) as ServiceStatus;
  const namespace = obj.metadata.namespace;
  const name = obj.metadata.name;
  const lbAddresses = (status.loadBalancer?.ingress ?? []).flatMap((i) => {
    const addr = i.ip ?? i.hostname;
    return addr ? [addr] : [];
  });
  const selector = spec.selector ?? {};
  const labelSelector = Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const headless = spec.clusterIP === 'None';
  const externalName = spec.type === 'ExternalName';
  const podsQuery = useResourceList(
    labelSelector ? { ctx, group: '', version: 'v1', plural: 'pods', namespace, labelSelector } : undefined,
  );
  // EndpointSlices are the truth about where traffic goes — they cover
  // selector-less Services too, and show pods the selector matches but
  // which aren't ready yet.
  const slicesQuery = useResourceList(
    namespace && !externalName
      ? { ctx, group: 'discovery.k8s.io', version: 'v1', plural: 'endpointslices', namespace, labelSelector: `kubernetes.io/service-name=${name}` }
      : undefined,
  );
  const endpoints = useMemo(() => endpointRows(slicesQuery.data?.items ?? []), [slicesQuery.data?.items]);
  const readyEndpoints = endpoints.filter((e) => e.state === 'Ready').length;
  const endpointsKnown = !!slicesQuery.data;
  const pods = podsQuery.data?.items ?? [];
  const ports = spec.ports ?? [];
  const dnsName = namespace ? `${name}.${namespace}.svc.cluster.local` : undefined;
  const externalAddresses = [...(spec.externalIPs ?? []), ...lbAddresses];

  const endpointTone = !endpointsKnown ? undefined : endpoints.length === 0 ? (labelSelector ? 'error' : undefined) : readyEndpoints === endpoints.length ? 'success' : 'warning';
  const noBackends = endpointsKnown && !externalName && endpoints.length === 0 && !!labelSelector && !podsQuery.isLoading;
  const noneReady = endpointsKnown && endpoints.length > 0 && readyEndpoints === 0;

  const openPod = (pod: string) => push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod, namespace });

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Type', value: spec.type ? `${spec.type}${headless ? ' · headless' : ''}` : undefined },
          externalName
            ? { label: 'External name', value: spec.externalName, mono: true }
            : { label: 'Cluster IP', value: headless ? 'None' : spec.clusterIP, mono: true },
          !externalName && {
            label: 'Endpoints',
            value: endpointsKnown ? `${readyEndpoints}/${endpoints.length}` : '…',
            tone: endpointTone,
            hint: 'Ready endpoints out of all addresses in this Service’s EndpointSlices.',
          },
          { label: 'Ports', value: String(ports.length) },
          externalAddresses.length > 0 && { label: 'External', value: externalAddresses.join(', '), mono: true },
        ]}
      />
      {noBackends && (
        <ProblemBanner
          severity="error"
          title="No endpoints"
          items={[
            {
              title: pods.length ? `${pods.length} matching pod${pods.length === 1 ? '' : 's'}, none ready` : 'The selector matches no pods',
              message: pods.length
                ? 'Traffic to this Service has nowhere to go until a matching pod passes its readiness probe.'
                : 'Traffic to this Service has nowhere to go. Check the selector against the pod labels it should match.',
            },
          ]}
        />
      )}
      {!noBackends && noneReady && (
        <ProblemBanner
          severity="warning"
          title="No ready endpoints"
          items={[{ title: `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}, none ready`, message: 'Every backing pod is failing its readiness probe or terminating.' }]}
        />
      )}
      <Section title="Addresses">
        <Facts>
          <Fact label="DNS name" mono hint="In-cluster name, assuming the default cluster domain (cluster.local).">
            {dnsName && (
              <>
                {dnsName} <CopyValueButton text={dnsName} label="Copy DNS name" />
              </>
            )}
          </Fact>
          <Fact label="Cluster IPs" mono>
            {(spec.clusterIPs ?? []).length > 1 ? spec.clusterIPs!.join(', ') : undefined}
          </Fact>
          <Fact label="External name" mono>
            {spec.externalName}
          </Fact>
          <Fact label="External IPs" mono>
            {(spec.externalIPs ?? []).join(', ')}
          </Fact>
          <Fact label="Load balancer" mono>
            {lbAddresses.join(', ')}
          </Fact>
          <Fact label="LB class">{spec.loadBalancerClass}</Fact>
        </Facts>
      </Section>
      {ports.length > 0 && (
        <Section title="Ports" count={ports.length} flush description={ports.map((p) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ')}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {ports.some((p) => p.name) && <TableCell>Name</TableCell>}
                <TableCell>Port</TableCell>
                <TableCell>Target</TableCell>
                {ports.some((p) => p.nodePort !== undefined) && <TableCell>Node port</TableCell>}
                <TableCell>Protocol</TableCell>
                <TableCell padding="none" />
              </TableRow>
            </TableHead>
            <TableBody>
              {ports.map((p, i) => (
                <TableRow key={p.name ?? i}>
                  {ports.some((q) => q.name) && <TableCell>{p.name ?? ''}</TableCell>}
                  <TableCell sx={{ fontWeight: 550 }}>{p.port}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>→ {p.targetPort ?? p.port}</TableCell>
                  {ports.some((q) => q.nodePort !== undefined) && <TableCell>{p.nodePort ?? ''}</TableCell>}
                  <TableCell>
                    {p.protocol ?? 'TCP'}
                    {p.appProtocol && (
                      <Typography component="span" variant="caption" color="text.secondary">
                        {` · ${p.appProtocol}`}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell padding="none" align="right" sx={{ pr: 0.5 }}>
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
      {!externalName && (
        <Section
          title="Endpoints"
          count={endpointsKnown ? endpoints.length : undefined}
          flush
          description={endpointsKnown && endpoints.length ? `${readyEndpoints} ready${endpoints.length - readyEndpoints ? ` · ${endpoints.length - readyEndpoints} not ready` : ''}` : undefined}
        >
          {endpoints.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
              {endpointsKnown ? 'No endpoints.' : 'Loading…'}
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Address</TableCell>
                  <TableCell>Pod</TableCell>
                  <TableCell>Node</TableCell>
                  <TableCell>State</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {endpoints.map((e, i) => (
                  <TableRow key={`${e.address}:${i}`}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{e.address}</TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      {e.pod ? (
                        <Link component="button" variant="body2" underline="hover" sx={{ textAlign: 'left', verticalAlign: 'baseline' }} onClick={() => openPod(e.pod!)}>
                          {e.pod}
                        </Link>
                      ) : (
                        ''
                      )}
                    </TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>{e.node ?? ''}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <StatusChip status={e.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      )}
      {labelSelector ? (
        <Section title="Matching pods" count={podsQuery.isLoading ? undefined : pods.length} flush description={<Box component="span" sx={{ fontFamily: 'monospace' }}>{labelSelector}</Box>}>
          <PodMiniList ctx={ctx} pods={pods} loading={podsQuery.isLoading} emptyText="No pods match the selector." hideNamespace />
        </Section>
      ) : (
        !externalName && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 0.5 }}>
            No selector — endpoints for this Service are managed manually or by a controller.
          </Typography>
        )
      )}
      <Section title="Details">
        <Facts>
          <Fact label="Selector" mono>
            {labelSelector}
          </Fact>
          <Fact label="Session affinity">
            {spec.sessionAffinity && spec.sessionAffinity !== 'None'
              ? `${spec.sessionAffinity}${spec.sessionAffinityConfig?.clientIP?.timeoutSeconds ? ` · ${spec.sessionAffinityConfig.clientIP.timeoutSeconds}s` : ''}`
              : undefined}
          </Fact>
          <Fact label="External traffic" hint="Local keeps the client source IP and only routes to pods on the receiving node.">
            {spec.externalTrafficPolicy}
          </Fact>
          <Fact label="Internal traffic" hint="Local only routes in-cluster traffic to pods on the same node.">
            {spec.internalTrafficPolicy && spec.internalTrafficPolicy !== 'Cluster' ? spec.internalTrafficPolicy : undefined}
          </Fact>
          <Fact label="IP families">{(spec.ipFamilies ?? []).join(', ')}</Fact>
          <Fact label="IP family policy">{spec.ipFamilyPolicy && spec.ipFamilyPolicy !== 'SingleStack' ? spec.ipFamilyPolicy : undefined}</Fact>
          <Fact label="Health check port">{spec.healthCheckNodePort !== undefined ? String(spec.healthCheckNodePort) : undefined}</Fact>
          <Fact label="Not-ready addresses" hint="Endpoints are published even while pods are not ready.">
            {spec.publishNotReadyAddresses ? 'Published' : undefined}
          </Fact>
        </Facts>
      </Section>
      <ConditionsTable obj={obj} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
      {forwardPort !== undefined && (
        <PortForwardDialog ctx={ctx} kind="Service" obj={obj} initialRemotePort={forwardPort} onClose={() => setForwardPort(undefined)} />
      )}
    </DetailStack>
  );
}
