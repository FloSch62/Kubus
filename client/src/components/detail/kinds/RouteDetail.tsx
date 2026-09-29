import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { ConditionsTable } from '../GenericDetail.js';
import { CustomResourceFooter } from '../CustomResourceDetail.js';
import { Fact, FactLink, Facts } from '../Facts.js';
import { ConditionOwnersSection, NestedConditionSections } from '../NestedConditions.js';
import { ProblemBanner, type ProblemItem } from '../ProblemBanner.js';
import { DetailStack, Section } from '../Section.js';
import { SummaryStrip, type SummaryTone } from '../SummaryStrip.js';
import {
  GATEWAY_GROUP,
  describeFilter,
  gatewayGoodWhen,
  parentConditionCount,
  routeParents,
  routeProtocol,
  ruleBackends,
  ruleMatches,
  type BackendRow,
  type RouteParent,
  type RouteSpec,
} from './gateway-api.js';
import { useObjectOpener } from './links.js';
import type { CustomKindViewProps } from './registry.js';

const countTone = ({ ok, total }: { ok: number; total: number }): SummaryTone | undefined => (total === 0 ? undefined : ok === total ? 'success' : ok === 0 ? 'error' : 'warning');

/**
 * Why a route is not (fully) serving: a parent that rejected it or could not
 * resolve its backends, in the controller's own words, or a parent no
 * controller has reported on at all.
 */
function routeProblems(parents: RouteParent[]): ProblemItem[] {
  const items: ProblemItem[] = [];
  for (const parent of parents) {
    if (!parent.statuses.length) {
      items.push({
        title: `${parent.label}: no status yet`,
        message: 'No controller has reported on this parent. Check that the Gateway exists and that its GatewayClass has a running controller.',
      });
      continue;
    }
    for (const status of parent.statuses) {
      for (const c of status.conditions) {
        if (c.status === gatewayGoodWhen(c.type) || c.status === 'Unknown') continue;
        items.push({ title: `${parent.label}: ${c.type} ${c.status}${c.reason ? ` (${c.reason})` : ''}`, message: c.message, at: c.lastTransitionTime });
      }
    }
  }
  return items;
}

/** Route status word for the drawer header. */
export function routeHeaderStatus(obj: KubeObject): string | undefined {
  const parents = routeParents(obj);
  if (!parents.length) return undefined;
  const accepted = parentConditionCount(parents, 'Accepted');
  const resolved = parentConditionCount(parents, 'ResolvedRefs');
  const rejected = parents.some((p) => p.statuses.some((s) => s.conditions.some((c) => c.type === 'Accepted' && c.status === 'False')));
  if (rejected) return 'NotAccepted';
  if (accepted.ok < accepted.total) return 'Pending';
  return resolved.ok < resolved.total ? 'Degraded' : 'Accepted';
}

function ShareBar({ share }: { share: number }) {
  return (
    <Box aria-hidden sx={{ width: 44, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden', flexShrink: 0 }}>
      <Box sx={{ width: `${share}%`, height: '100%', bgcolor: 'primary.main', opacity: 0.8 }} />
    </Box>
  );
}

function BackendLine({ backend, routeNamespace, open }: { backend: BackendRow; routeNamespace: string; open?: () => void }) {
  const kindPrefix = backend.kind === 'Service' && backend.group === '' ? '' : `${backend.kind} `;
  const where = backend.namespace !== routeNamespace ? `${backend.namespace}/${backend.name}` : backend.name;
  const text = `${kindPrefix}${where}${backend.port !== undefined ? `:${backend.port}` : ''}`;
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <Box sx={{ minWidth: 0, flex: 1, fontFamily: 'monospace', fontSize: 12.5, overflowWrap: 'anywhere' }}>
        {open ? <FactLink onClick={open}>{text}</FactLink> : text}
      </Box>
      {backend.share !== undefined && <ShareBar share={backend.share} />}
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap', minWidth: 76, textAlign: 'right' }} title={`weight ${backend.weight}`}>
        {backend.share !== undefined ? `${backend.share}%` : 'no traffic'} · w{backend.weight}
      </Typography>
    </Stack>
  );
}

/**
 * HTTPRoute and GRPCRoute (and the connection-level TCP, TLS and UDP
 * routes): which requests the route matches and where each match goes,
 * with weights, and whether every parent Gateway accepted it.
 */
export function RouteDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const open = useObjectOpener(ctx);
  const namespace = obj.metadata.namespace ?? '';
  const protocol = routeProtocol(obj.kind);
  const spec = (obj.spec ?? {}) as RouteSpec;
  const rules = spec.rules ?? [];
  const parents = useMemo(() => routeParents(obj), [obj]);
  const accepted = parentConditionCount(parents, 'Accepted');
  const resolved = parentConditionCount(parents, 'ResolvedRefs');
  const problems = useMemo(() => routeProblems(parents), [parents]);
  const backendCount = new Set(rules.flatMap((rule) => ruleBackends(rule, namespace).map((b) => `${b.kind}/${b.namespace}/${b.name}:${b.port ?? ''}`))).size;
  const hostnames = spec.hostnames ?? [];

  const owners = parents.map((parent) => ({
    label: parent.label,
    detail: parent.statuses.map((s) => s.controllerName).filter(Boolean).join(', ') || undefined,
    conditions: parent.statuses.flatMap((s) => s.conditions),
    onOpen: open({ group: parent.ref.group ?? GATEWAY_GROUP, kind: parent.ref.kind ?? 'Gateway', name: parent.ref.name, namespace: parent.ref.namespace ?? namespace }),
    note: parent.statuses.length ? undefined : 'No controller has reported on this parent yet.',
  }));

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Accepted', value: `${accepted.ok}/${accepted.total}`, tone: countTone(accepted), hint: 'Parent Gateways that accepted this route.' },
          { label: 'Refs resolved', value: `${resolved.ok}/${resolved.total}`, tone: countTone(resolved), hint: 'Parent Gateways that resolved every backend of this route.' },
          { label: 'Rules', value: String(rules.length) },
          { label: 'Backends', value: String(backendCount) },
        ]}
      />
      {problems.length > 0 && (
        <ProblemBanner severity={accepted.ok === 0 ? 'error' : 'warning'} title="Why this route isn’t fully serving" items={problems} />
      )}
      <Section title="Rules" count={rules.length} flush description={protocol === 'grpc' ? 'gRPC methods → backends' : protocol === 'http' ? 'requests → backends' : 'connections → backends'}>
        <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Facts>
            <Fact label="Hostnames" mono>
              {hostnames.length ? hostnames.join(', ') : <Box component="span" sx={{ color: 'text.secondary', fontFamily: 'inherit' }}>any (from the listener)</Box>}
            </Fact>
          </Facts>
        </Box>
        {rules.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            No rules. Traffic that reaches this route is rejected with a 404.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 32 }}>#</TableCell>
                <TableCell sx={{ width: '42%' }}>Matches</TableCell>
                <TableCell>Backends</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.map((rule, i) => {
                const matches = ruleMatches(rule, protocol);
                const backends = ruleBackends(rule, namespace);
                const extras = [...(rule.filters ?? []).map(describeFilter), rule.timeouts?.request && `timeout ${rule.timeouts.request}`, rule.timeouts?.backendRequest && `backend timeout ${rule.timeouts.backendRequest}`].filter(
                  (line): line is string => !!line,
                );
                return (
                  <TableRow key={i} sx={{ verticalAlign: 'top' }}>
                    <TableCell sx={{ color: 'text.secondary' }}>{i + 1}</TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        {rule.name && (
                          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                            {rule.name}
                          </Typography>
                        )}
                        {matches.map((lines, m) => (
                          <Box key={m}>
                            {m > 0 && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
                                or
                              </Typography>
                            )}
                            {lines.map((line, l) => (
                              <Box key={l} sx={{ fontFamily: 'monospace', fontSize: 12.5, overflowWrap: 'anywhere', lineHeight: 1.6 }}>
                                {line}
                              </Box>
                            ))}
                          </Box>
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        {backends.length === 0 && (
                          <Typography variant="body2" color="text.secondary">
                            {rule.filters?.some((f) => f.type === 'RequestRedirect') ? 'Redirect only' : 'No backends (500)'}
                          </Typography>
                        )}
                        {backends.map((b, j) => (
                          <BackendLine key={j} backend={b} routeNamespace={namespace} open={open({ group: b.group, kind: b.kind, name: b.name, namespace: b.namespace })} />
                        ))}
                        {extras.map((line, j) => (
                          <Typography key={`x${j}`} variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                            {line}
                          </Typography>
                        ))}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      <ConditionOwnersSection
        title="Parents"
        owners={owners}
        goodWhen={gatewayGoodWhen}
        emptyText="No parent references: the route is not attached to any Gateway."
      />
      <NestedConditionSections obj={obj} exclude={['parents']} />
      <ConditionsTable obj={obj} />
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}
