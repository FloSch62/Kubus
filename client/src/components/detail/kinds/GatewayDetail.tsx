import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { StatusChip } from '../../StatusChip.js';
import { ConditionRows } from '../GenericDetail.js';
import { CustomResourceFooter } from '../CustomResourceDetail.js';
import { Fact, FactLink, Facts } from '../Facts.js';
import { NestedConditionSections } from '../NestedConditions.js';
import { conditionHealthy, conditionList, type DetailCondition } from '../nested-conditions.js';
import { ProblemBanner, type ProblemItem } from '../ProblemBanner.js';
import { DetailStack, Section } from '../Section.js';
import { SummaryStrip } from '../SummaryStrip.js';
import { GATEWAY_GROUP, conditionOf, gatewayGoodWhen, listenerRows, routeAttachesTo, type ListenerRow, type RouteSpec } from './gateway-api.js';
import { useKindList, useObjectOpener } from './links.js';
import { conditionTile } from './tiles.js';
import type { CustomKindViewProps } from './registry.js';

const ROUTE_KINDS = ['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute'] as const;

/** One word for a set of conditions: Ready when all are healthy, the first failing type otherwise. */
function listenerState(conditions: DetailCondition[]): { status: string; label: string } {
  if (!conditions.length) return { status: 'Unknown', label: 'No status' };
  const bad = conditions.find((c) => !conditionHealthy(c, gatewayGoodWhen));
  if (!bad) return { status: 'Ready', label: 'Ready' };
  return { status: bad.status === 'Unknown' ? 'Unknown' : 'NotReady', label: bad.reason ?? `${bad.type} ${bad.status}` };
}

/** Gateway status word for the drawer header: Programmed, or what stops it. */
export function gatewayHeaderStatus(obj: KubeObject): string | undefined {
  const programmed = conditionOf(obj, 'Programmed');
  const accepted = conditionOf(obj, 'Accepted');
  if (accepted?.status === 'False') return 'NotAccepted';
  if (!programmed) return accepted?.status === 'True' ? 'Accepted' : undefined;
  return programmed.status === 'True' ? 'Programmed' : programmed.status === 'False' ? 'NotProgrammed' : 'Pending';
}

function gatewayProblems(obj: KubeObject, listeners: ListenerRow[]): ProblemItem[] {
  const items: ProblemItem[] = [];
  for (const c of conditionList((obj.status as { conditions?: unknown } | undefined)?.conditions) ?? []) {
    if (conditionHealthy(c, gatewayGoodWhen) || c.status === 'Unknown') continue;
    items.push({ title: `${c.type} ${c.status}${c.reason ? ` (${c.reason})` : ''}`, message: c.message, at: c.lastTransitionTime });
  }
  for (const l of listeners) {
    for (const c of l.conditions) {
      if (conditionHealthy(c, gatewayGoodWhen) || c.status === 'Unknown') continue;
      items.push({ title: `Listener ${l.name}: ${c.type} ${c.status}${c.reason ? ` (${c.reason})` : ''}`, message: c.message, at: c.lastTransitionTime });
    }
  }
  return items;
}

/** Whether the route's status says this Gateway accepted it: True, False, or undefined when not reported. */
function acceptedBy(route: KubeObject, gateway: KubeObject): string | undefined {
  const parents = (route.status as { parents?: Array<{ parentRef?: { name?: string; namespace?: string }; conditions?: unknown }> } | undefined)?.parents ?? [];
  const ns = route.metadata.namespace ?? '';
  const mine = parents.filter((p) => p.parentRef?.name === gateway.metadata.name && (p.parentRef.namespace ?? ns) === (gateway.metadata.namespace ?? ''));
  const states = mine.flatMap((p) => (conditionList(p.conditions) ?? []).filter((c) => c.type === 'Accepted').map((c) => c.status));
  if (!states.length) return undefined;
  return states.every((s) => s === 'True') ? 'True' : states.includes('False') ? 'False' : 'Unknown';
}

/**
 * Gateway: its listeners (protocol, port, hostname, TLS, which routes may
 * attach and how many did), the routes that name it, and why a listener
 * or the Gateway itself is not programmed.
 */
export function GatewayDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const open = useObjectOpener(ctx);
  const namespace = obj.metadata.namespace ?? '';
  const spec = (obj.spec ?? {}) as { gatewayClassName?: string; addresses?: Array<{ type?: string; value?: string }> };
  const status = (obj.status ?? {}) as { addresses?: Array<{ type?: string; value?: string }> };
  const listeners = useMemo(() => listenerRows(obj), [obj]);
  const problems = useMemo(() => gatewayProblems(obj, listeners), [obj, listeners]);
  const attached = listeners.reduce((sum, l) => sum + (l.attachedRoutes ?? 0), 0);
  const reported = listeners.some((l) => l.attachedRoutes !== undefined);
  const programmed = conditionOf(obj, 'Programmed');
  const addresses = (status.addresses ?? []).map((a) => a.value).filter((v): v is string => !!v);

  // Routes are few next to everything else, so a cluster-wide list per kind
  // is cheap and finds the ones in other namespaces too.
  const lists = [
    useKindList(ctx, GATEWAY_GROUP, ROUTE_KINDS[0]),
    useKindList(ctx, GATEWAY_GROUP, ROUTE_KINDS[1]),
    useKindList(ctx, GATEWAY_GROUP, ROUTE_KINDS[2]),
    useKindList(ctx, GATEWAY_GROUP, ROUTE_KINDS[3]),
    useKindList(ctx, GATEWAY_GROUP, ROUTE_KINDS[4]),
  ];
  const routes = lists
    .flatMap((q) => q.data?.items ?? [])
    .filter((route) => routeAttachesTo(route, { name: obj.metadata.name, namespace }))
    .sort((a, b) => `${a.kind}/${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.kind}/${b.metadata.namespace}/${b.metadata.name}`));
  const routesLoading = lists.some((q) => q.isLoading);
  const gatewayConditions = conditionList((obj.status as { conditions?: unknown } | undefined)?.conditions) ?? [];

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          conditionTile('Programmed', programmed, 'The data plane is configured for this Gateway.'),
          { label: 'Listeners', value: String(listeners.length) },
          { label: 'Attached routes', value: reported ? String(attached) : '—', hint: 'Routes the controller attached, summed over listeners.' },
          addresses.length > 0 && { label: 'Address', value: addresses[0], mono: true, title: addresses.join(', ') },
        ]}
      />
      {problems.length > 0 && <ProblemBanner severity={programmed?.status === 'False' ? 'error' : 'warning'} title="Why this Gateway isn’t fully programmed" items={problems} />}
      <Section title="Listeners" count={listeners.length} flush>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Listens on</TableCell>
              <TableCell>Routes</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {listeners.map((l) => {
              const state = listenerState(l.conditions);
              return (
                <TableRow key={l.name} sx={{ verticalAlign: 'top' }}>
                  <TableCell sx={{ fontWeight: 600, wordBreak: 'break-word' }}>{l.name}</TableCell>
                  <TableCell>
                    <Box sx={{ fontFamily: 'monospace', fontSize: 12.5 }}>
                      {l.protocol ?? '?'} :{l.port ?? '?'}
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
                      {l.hostname ?? 'any hostname'}
                    </Typography>
                    {l.tlsMode && (
                      <Typography component="div" variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                        TLS {l.tlsMode}
                        {l.certificates.map((cert) => {
                          const opener = open({ group: cert.group, kind: cert.kind, name: cert.name, namespace: cert.namespace ?? namespace });
                          return (
                            <Box component="span" key={`${cert.kind}/${cert.name}`}>
                              {' · '}
                              {opener ? <FactLink onClick={opener}>{cert.name}</FactLink> : cert.name}
                            </Box>
                          );
                        })}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {l.attachedRoutes ?? '—'} attached
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {l.kinds.length ? l.kinds.join(', ') : 'protocol default kinds'} · {l.namespaces.toLowerCase()}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={state.status} label={state.label} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>
      <Section title="Routes" count={routes.length} flush description={routesLoading ? undefined : 'routes whose parentRefs name this Gateway'}>
        {routes.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            {routesLoading ? 'Loading routes…' : 'No route names this Gateway as a parent.'}
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Route</TableCell>
                <TableCell>Hostnames</TableCell>
                <TableCell>Accepted here</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {routes.map((route) => {
                const opener = open({ group: GATEWAY_GROUP, kind: route.kind ?? 'HTTPRoute', name: route.metadata.name, namespace: route.metadata.namespace });
                const label = `${route.metadata.namespace !== namespace ? `${route.metadata.namespace}/` : ''}${route.metadata.name}`;
                const accepted = acceptedBy(route, obj);
                return (
                  <TableRow key={route.metadata.uid} sx={{ verticalAlign: 'top' }}>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {route.kind}
                      </Typography>
                      {opener ? <FactLink onClick={opener}>{label}</FactLink> : label}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12.5, wordBreak: 'break-all' }}>{((route.spec as RouteSpec | undefined)?.hostnames ?? []).join(', ') || '—'}</TableCell>
                    <TableCell>{accepted ? <StatusChip status={accepted} /> : <Typography variant="body2" color="text.secondary">not reported</Typography>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      <NestedConditionSections obj={obj} goodWhen={gatewayGoodWhen} collapseWhenHealthy />
      <Section title="Details">
        <Facts>
          <Fact label="Class">
            {spec.gatewayClassName &&
              (() => {
                const opener = open({ group: GATEWAY_GROUP, kind: 'GatewayClass', name: spec.gatewayClassName });
                return opener ? <FactLink onClick={opener}>{spec.gatewayClassName}</FactLink> : spec.gatewayClassName;
              })()}
          </Fact>
          <Fact label="Addresses" mono>
            {addresses.length ? addresses.join(', ') : undefined}
          </Fact>
          <Fact label="Requested" hint="Addresses asked for in spec.addresses.">
            {(spec.addresses ?? []).map((a) => a.value).filter(Boolean).join(', ') || undefined}
          </Fact>
        </Facts>
      </Section>
      {gatewayConditions.length > 0 && (
        <Section title="Conditions" count={gatewayConditions.length} flush defaultOpen={gatewayConditions.some((c) => !conditionHealthy(c, gatewayGoodWhen))}>
          <ConditionRows conditions={gatewayConditions} goodWhen={gatewayGoodWhen} />
        </Section>
      )}
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}
