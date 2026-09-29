import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { StatusChip } from '../../StatusChip.js';
import { ConditionsTable } from '../GenericDetail.js';
import { CustomResourceFooter } from '../CustomResourceDetail.js';
import { ClampedText } from '../ClampedText.js';
import { Fact, FactLink, Facts } from '../Facts.js';
import { ProblemBanner } from '../ProblemBanner.js';
import { DetailStack, Section } from '../Section.js';
import { SummaryStrip } from '../SummaryStrip.js';
import { GATEWAY_GROUP, conditionOf, listenerRows } from './gateway-api.js';
import { gatewayHeaderStatus } from './GatewayDetail.js';
import { useKindList, useObjectOpener } from './links.js';
import { conditionTile } from './tiles.js';
import type { CustomKindViewProps } from './registry.js';

/** GatewayClass status word for the drawer header. */
export function gatewayClassHeaderStatus(obj: KubeObject): string | undefined {
  const accepted = conditionOf(obj, 'Accepted');
  return accepted ? (accepted.status === 'True' ? 'Accepted' : accepted.status === 'False' ? 'NotAccepted' : 'Pending') : undefined;
}

/**
 * GatewayClass: the controller that implements it, whether that controller
 * accepted the class, and the Gateways built from it.
 */
export function GatewayClassDetail({ obj, ctx, crd, version }: CustomKindViewProps) {
  const open = useObjectOpener(ctx);
  const spec = (obj.spec ?? {}) as { controllerName?: string; description?: string; parametersRef?: { group?: string; kind?: string; name?: string; namespace?: string } };
  const accepted = conditionOf(obj, 'Accepted');
  const gatewaysQuery = useKindList(ctx, GATEWAY_GROUP, 'Gateway');
  const gateways = (gatewaysQuery.data?.items ?? [])
    .filter((gw) => (gw.spec as { gatewayClassName?: string } | undefined)?.gatewayClassName === obj.metadata.name)
    .sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
  const attachedTotal = gateways.reduce((n, gw) => n + listenerRows(gw).reduce((m, l) => m + (l.attachedRoutes ?? 0), 0), 0);
  const params = spec.parametersRef;
  const paramsOpener = params?.name && params.kind ? open({ group: params.group ?? '', kind: params.kind, name: params.name, namespace: params.namespace }) : undefined;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          conditionTile('Accepted', accepted, 'The controller named by this class has taken it on.'),
          { label: 'Gateways', value: gatewaysQuery.isLoading ? '…' : String(gateways.length) },
          { label: 'Attached routes', value: gatewaysQuery.isLoading ? '…' : String(attachedTotal), hint: 'Routes attached to the Gateways of this class.' },
        ]}
      />
      {accepted?.status === 'False' && (
        <ProblemBanner severity="error" title="The controller rejected this class" items={[{ title: accepted.reason ?? 'NotAccepted', message: accepted.message, at: accepted.lastTransitionTime }]} />
      )}
      <Section title="Details">
        <Facts>
          <Fact label="Controller" mono>
            {spec.controllerName}
          </Fact>
          <Fact label="Description">{spec.description && <ClampedText text={spec.description} lines={4} />}</Fact>
          <Fact label="Parameters">
            {params?.name && (paramsOpener ? <FactLink onClick={paramsOpener}>{`${params.kind} ${params.name}`}</FactLink> : `${params.kind ?? ''} ${params.name}`.trim())}
          </Fact>
        </Facts>
      </Section>
      <Section title="Gateways" count={gateways.length} flush>
        {gateways.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            {gatewaysQuery.isLoading ? 'Loading Gateways…' : 'No Gateway uses this class.'}
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Gateway</TableCell>
                <TableCell>Listeners</TableCell>
                <TableCell>Attached routes</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {gateways.map((gw) => {
                const opener = open({ group: GATEWAY_GROUP, kind: 'Gateway', name: gw.metadata.name, namespace: gw.metadata.namespace });
                const listeners = listenerRows(gw);
                const attached = listeners.some((l) => l.attachedRoutes !== undefined) ? listeners.reduce((n, l) => n + (l.attachedRoutes ?? 0), 0) : undefined;
                const label = `${gw.metadata.namespace}/${gw.metadata.name}`;
                const state = gatewayHeaderStatus(gw);
                return (
                  <TableRow key={gw.metadata.uid}>
                    <TableCell sx={{ wordBreak: 'break-word' }}>{opener ? <FactLink onClick={opener}>{label}</FactLink> : label}</TableCell>
                    <TableCell>{listeners.map((l) => `${l.protocol ?? '?'}:${l.port ?? '?'}`).join(', ') || '—'}</TableCell>
                    <TableCell>{attached ?? '—'}</TableCell>
                    <TableCell>{state ? <StatusChip status={state} /> : '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      <ConditionsTable obj={obj} />
      <CustomResourceFooter obj={obj} ctx={ctx} crd={crd} version={version} />
    </DetailStack>
  );
}
