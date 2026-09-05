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
import { DETAIL_LIST_LIVE_MS, useResourceList } from '../../api/queries.js';
import { KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { PodMiniList } from './PodMiniList.js';
import { ProblemBanner } from './ProblemBanner.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { labelSelectorToString, type LabelSelector } from './selectors.js';

interface Peer {
  podSelector?: LabelSelector;
  namespaceSelector?: LabelSelector;
  ipBlock?: { cidr?: string; except?: string[] };
}

interface PolicyPort {
  protocol?: string;
  port?: number | string;
  endPort?: number;
}

interface Rule {
  from?: Peer[];
  to?: Peer[];
  ports?: PolicyPort[];
}

interface NetworkPolicySpec {
  podSelector?: LabelSelector;
  policyTypes?: string[];
  ingress?: Rule[];
  egress?: Rule[];
}

const MONO = { fontFamily: 'monospace', fontSize: 12 } as const;

/** Whether a selector selects everything (empty) — the "all pods in the namespace" case. */
export function selectsAll(selector: LabelSelector | undefined): boolean {
  return !selector || (!Object.keys(selector.matchLabels ?? {}).length && !(selector.matchExpressions ?? []).length);
}

/** Effective policy types: explicit, else Ingress always plus Egress when egress rules exist. */
export function effectivePolicyTypes(spec: NetworkPolicySpec): string[] {
  if (spec.policyTypes?.length) return spec.policyTypes;
  return spec.egress ? ['Ingress', 'Egress'] : ['Ingress'];
}

/** One peer as readable text: "pods app=web in namespaces team=a", "10.0.0.0/8 except 10.0.1.0/24". */
export function describePeer(peer: Peer): string {
  if (peer.ipBlock) {
    const except = peer.ipBlock.except?.length ? ` except ${peer.ipBlock.except.join(', ')}` : '';
    return `${peer.ipBlock.cidr ?? '?'}${except}`;
  }
  const pods = peer.podSelector !== undefined ? (selectsAll(peer.podSelector) ? 'all pods' : `pods ${labelSelectorToString(peer.podSelector)}`) : undefined;
  const namespaces =
    peer.namespaceSelector !== undefined
      ? selectsAll(peer.namespaceSelector)
        ? 'any namespace'
        : `namespaces ${labelSelectorToString(peer.namespaceSelector)}`
      : undefined;
  if (pods && namespaces) return `${pods} in ${namespaces}`;
  if (pods) return `${pods} in this namespace`;
  if (namespaces) return `all pods in ${namespaces}`;
  return 'anywhere';
}

export function describePorts(ports: PolicyPort[] | undefined): string {
  if (!ports?.length) return 'all ports';
  return ports.map((p) => `${p.port ?? 'any'}${p.endPort !== undefined ? `–${p.endPort}` : ''}/${p.protocol ?? 'TCP'}`).join(', ');
}

/**
 * What a NetworkPolicy actually does, in words: which pods it applies to,
 * whether it isolates them for ingress or egress, and each rule as "from /
 * to" peers and ports — the answer to "why can't it reach that service"
 * without reading YAML.
 */
export function NetworkPolicyDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = (obj.spec ?? {}) as NetworkPolicySpec;
  const namespace = obj.metadata.namespace;
  const types = effectivePolicyTypes(spec);
  const isolatesIngress = types.includes('Ingress');
  const isolatesEgress = types.includes('Egress');
  const ingressRules = spec.ingress ?? [];
  const egressRules = spec.egress ?? [];
  const selector = spec.podSelector;
  const all = selectsAll(selector);
  const selectorText = labelSelectorToString(selector);
  // An empty selector selects every pod in the namespace — the API accepts
  // no label selector for that, so list the namespace and keep all rows.
  const podsQuery = useResourceList(namespace ? { ctx, group: '', version: 'v1', plural: 'pods', namespace, labelSelector: all ? undefined : selectorText } : undefined, {
    liveMs: DETAIL_LIST_LIVE_MS,
  });
  const pods = podsQuery.data?.items ?? [];

  const denyAllIngress = isolatesIngress && ingressRules.length === 0;
  const denyAllEgress = isolatesEgress && egressRules.length === 0;
  const problems = useMemo(() => {
    const items = [];
    if (denyAllIngress) items.push({ title: 'No ingress allowed by this policy', message: 'This policy isolates the selected pods for ingress and allows no incoming traffic. Other policies selecting these pods may still allow it.' });
    if (denyAllEgress) items.push({ title: 'No egress allowed by this policy', message: 'This policy isolates the selected pods for egress and allows no outgoing traffic, including DNS. Other policies selecting these pods may still allow it.' });
    return items;
  }, [denyAllIngress, denyAllEgress]);

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Applies to', value: podsQuery.isLoading ? '…' : `${pods.length} pod${pods.length === 1 ? '' : 's'}`, hint: all ? 'Every pod in the namespace (empty pod selector).' : `Pods matching ${selectorText}` },
          { label: 'Ingress', value: isolatesIngress ? (ingressRules.length ? `${ingressRules.length} rule${ingressRules.length === 1 ? '' : 's'}` : 'no allowed traffic') : 'not isolated', tone: denyAllIngress ? 'warning' : undefined },
          { label: 'Egress', value: isolatesEgress ? (egressRules.length ? `${egressRules.length} rule${egressRules.length === 1 ? '' : 's'}` : 'no allowed traffic') : 'not isolated', tone: denyAllEgress ? 'warning' : undefined },
          { label: 'Policy types', value: types.join(' + ') },
        ]}
      />
      {problems.length > 0 && <ProblemBanner severity="warning" title="This policy allows no traffic in an isolated direction" items={problems} />}
      {isolatesIngress && ingressRules.length > 0 && <RuleTable title="Ingress rules" direction="from" rules={ingressRules} />}
      {isolatesEgress && egressRules.length > 0 && <RuleTable title="Egress rules" direction="to" rules={egressRules} />}
      <Section
        title="Selected pods"
        count={podsQuery.isLoading ? undefined : pods.length}
        flush
        description={all ? 'all pods in the namespace' : <Box component="span" sx={{ fontFamily: 'monospace' }}>{selectorText}</Box>}
      >
        <PodMiniList ctx={ctx} pods={pods} loading={podsQuery.isLoading} emptyText="No pods match the selector, so the policy affects nothing right now." hideNamespace />
      </Section>
      <Section title="Details">
        <Facts>
          <Fact label="Pod selector" mono>
            {all ? '(all pods in namespace)' : selectorText}
          </Fact>
          <Fact label="Policy types" hint="Ingress isolates incoming traffic; Egress isolates outgoing. A type without rules allows no traffic in that direction; other selecting policies may still allow it.">
            {types.join(', ')}
          </Fact>
        </Facts>
      </Section>
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}

function RuleTable({ title, direction, rules }: { title: string; direction: 'from' | 'to'; rules: Rule[] }) {
  return (
    <Section title={title} count={rules.length} flush description={direction === 'from' ? 'who may reach the selected pods' : 'where the selected pods may connect'}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 36 }}>#</TableCell>
            <TableCell>{direction === 'from' ? 'From' : 'To'}</TableCell>
            <TableCell>Ports</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rules.map((rule, i) => {
            const peers = direction === 'from' ? rule.from : rule.to;
            return (
              <TableRow key={i}>
                <TableCell sx={{ verticalAlign: 'top', color: 'text.secondary' }}>{i + 1}</TableCell>
                <TableCell sx={{ verticalAlign: 'top', wordBreak: 'break-word' }}>
                  {peers?.length ? (
                    <Stack spacing={0.25}>
                      {peers.map((peer, j) => (
                        <Typography key={j} variant="body2" sx={peer.ipBlock ? MONO : undefined}>
                          {describePeer(peer)}
                        </Typography>
                      ))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      anywhere
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{ verticalAlign: 'top', whiteSpace: 'nowrap', ...MONO }}>{describePorts(rule.ports)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}
