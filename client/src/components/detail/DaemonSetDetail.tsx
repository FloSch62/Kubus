import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { KubeObject } from '@kubus/shared';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { useWatchedList } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';
import { statusTextColor } from '../../theme.js';
import { MiniFilterInput, matchesMiniFilter } from '../MiniFilterInput.js';
import { naturalCompare } from '../natural-sort.js';
import { StatusChip } from '../StatusChip.js';
import { ControllerRevisions } from './ControllerRevisions.js';
import { coverageKey, groupExclusions, nodeCoverage, type DaemonPodSpec, type ExclusionGroup, type NodeCoverage, type Toleration } from './daemon-placement.js';
import { Fact, Facts } from './Facts.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { ProblemBanner } from './ProblemBanner.js';
import { ReplicaBar } from './ReplicaBar.js';
import { DetailStack, Section } from './Section.js';
import { labelSelectorToString, type LabelSelector } from './selectors.js';
import type { SchedulingIssue } from './scheduling.js';
import { SummaryStrip } from './SummaryStrip.js';
import { UsedBySection } from './UsedBySection.js';
import { controlledBy, useSelectorPods, useWorkloadProblems, WorkloadContainers, WorkloadPods, type PodTemplateSpec } from './WorkloadParts.js';

interface DaemonSetSpec {
  selector?: LabelSelector;
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
  updateStrategy?: { type?: string; rollingUpdate?: { maxUnavailable?: number | string; maxSurge?: number | string } };
  template?: { spec?: PodTemplateSpec & DaemonPodSpec };
}

interface DaemonSetStatus {
  desiredNumberScheduled?: number;
  currentNumberScheduled?: number;
  numberReady?: number;
  numberAvailable?: number;
  numberUnavailable?: number;
  numberMisscheduled?: number;
  updatedNumberScheduled?: number;
}

const SELECTOR_KINDS = ['Service', 'PodDisruptionBudget', 'NetworkPolicy'];

/** Rows a node table needs before it grows a filter box. */
const NODE_FILTER_THRESHOLD = 8;

function tolerationText(t: Toleration): string {
  if (!t.key && t.operator === 'Exists') return t.effect ? `every ${t.effect} taint` : 'every taint';
  const value = t.operator === 'Exists' ? '' : `=${t.value ?? ''}`;
  return `${t.key}${value}${t.effect ? `:${t.effect}` : ''}`;
}

export function DaemonSetDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const namespace = obj.metadata.namespace;
  const spec = obj.spec as DaemonSetSpec | undefined;
  const status = obj.status as DaemonSetStatus | undefined;
  const labelSelector = labelSelectorToString(spec?.selector) || undefined;
  const podsQuery = useSelectorPods(ctx, namespace, labelSelector);
  const pods = useMemo(() => {
    const owned = (podsQuery.data?.items ?? []).filter((pod) => controlledBy(pod, new Set([obj.metadata.uid])));
    const nodeOf = (pod: KubeObject) => (pod.spec as { nodeName?: string } | undefined)?.nodeName ?? '';
    return owned.sort((a, b) => naturalCompare(nodeOf(a), nodeOf(b)) || naturalCompare(a.metadata.name, b.metadata.name));
  }, [podsQuery.data?.items, obj.metadata.uid]);

  const desired = status?.desiredNumberScheduled ?? 0;
  const ready = status?.numberReady ?? 0;
  const misscheduled = status?.numberMisscheduled ?? 0;
  const { problems, issues } = useWorkloadProblems({ ctx, kind: 'DaemonSet', obj, pods, active: (desired > 0 && ready < desired) || misscheduled > 0 });
  const readyTone = desired === 0 ? undefined : ready >= desired ? 'success' : ready === 0 ? 'error' : 'warning';
  const rolling = spec?.updateStrategy?.rollingUpdate;
  const template = spec?.template?.spec;
  const nodeSelector = Object.entries(template?.nodeSelector ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Desired', value: String(desired), hint: 'Nodes that should run a pod of this DaemonSet.' },
          { label: 'Current', value: String(status?.currentNumberScheduled ?? 0), hint: 'Nodes that should run a pod and have one.' },
          { label: 'Ready', value: `${ready}/${desired}`, tone: readyTone },
          { label: 'Up-to-date', value: String(status?.updatedNumberScheduled ?? 0), hint: 'Nodes running a pod from the current pod template.' },
          { label: 'Misscheduled', value: String(misscheduled), tone: misscheduled > 0 ? 'warning' : undefined, hint: 'Nodes running a pod of this DaemonSet that should not.' },
        ]}
      />
      <ReplicaBar desired={desired} ready={ready} total={status?.currentNumberScheduled ?? 0} updated={status?.updatedNumberScheduled ?? 0} />
      {problems.length > 0 && <ProblemBanner severity={ready === 0 && desired > 0 ? 'error' : 'warning'} title="Why this DaemonSet isn’t ready" items={problems} />}
      <WorkloadContainers ctx={ctx} kind="DaemonSet" obj={obj} pods={pods} template={template} />
      <WorkloadPods
        ctx={ctx}
        pods={pods}
        loading={podsQuery.isLoading}
        emptyText={labelSelector ? 'No pods owned by this DaemonSet.' : 'No selector on this DaemonSet.'}
        issues={issues}
        showNode
      />
      <NodesSection ctx={ctx} pods={pods} podsLoading={podsQuery.isLoading} podsError={podsQuery.error} spec={template} issues={issues} desired={desired} />
      <ControllerRevisions ctx={ctx} obj={obj} pods={pods} labelSelector={labelSelector} />
      <UsedBySection
        target={{ ctx, group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet', name: obj.metadata.name, namespace }}
        title="Selected by"
        kinds={SELECTOR_KINDS}
        emptyText="No Service, PodDisruptionBudget or NetworkPolicy selects this DaemonSet's pods."
        defaultOpen={false}
      />
      <Section title="Details">
        <Facts>
          <Fact label="Selector" mono>
            {labelSelector}
          </Fact>
          <Fact label="Update strategy">
            {spec?.updateStrategy?.type && (
              <>
                {spec.updateStrategy.type}
                {rolling && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {` · max unavailable ${rolling.maxUnavailable ?? '-'} · max surge ${rolling.maxSurge ?? '-'}`}
                  </Box>
                )}
              </>
            )}
          </Fact>
          <Fact label="Node selector" mono>
            {nodeSelector}
          </Fact>
          <Fact label="Node affinity">{template?.affinity?.nodeAffinity ? 'required terms set, see the Manifest tab' : undefined}</Fact>
          <Fact label="Tolerations" hint="Taints the pods tolerate, on top of the node-condition tolerations every DaemonSet pod gets.">
            {(template?.tolerations ?? []).map(tolerationText).join(', ')}
          </Fact>
          <Fact label="Host network">{template?.hostNetwork ? 'Yes' : undefined}</Fact>
          <Fact label="Min ready" hint="Seconds a new pod must be ready before it counts as available.">
            {spec?.minReadySeconds !== undefined ? `${spec.minReadySeconds}s` : undefined}
          </Fact>
          <Fact label="History limit" hint="Old revisions kept for rollback.">
            {spec?.revisionHistoryLimit !== undefined ? String(spec.revisionHistoryLimit) : undefined}
          </Fact>
          <Fact label="Service account">{template?.serviceAccountName}</Fact>
        </Facts>
      </Section>
      <ConditionsTable obj={obj} defaultOpen={false} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}

const STATE_CHIP: Record<Exclude<NodeCoverage['state'], 'running' | 'not-ready'>, { status: string; label: string }> = {
  pending: { status: 'Pending', label: 'Pending' },
  missing: { status: 'warning', label: 'No pod' },
  misscheduled: { status: 'warning', label: 'Misscheduled' },
  excluded: { status: 'excluded', label: 'Excluded' },
};

/** Node rows rendered before "Show all", and node names listed per excluded group. */
export const NODE_ROW_LIMIT = 50;
const GROUP_NODE_LIMIT = 100;

const TABLE_SX = { '& th, & td': { px: 1 }, '& th:first-of-type, & td:first-of-type': { pl: 2 } };

/**
 * Every node that is not running a ready pod of this DaemonSet, and why: the
 * scheduler's answer for a pod stuck Pending there, a pod on a node it no
 * longer fits, or (folded into one row per reason) the selector, affinity or
 * taint that leaves nodes out. Nothing is claimed until both the nodes and
 * the pods are known.
 */
function NodesSection({
  ctx,
  pods,
  podsLoading,
  podsError,
  spec,
  issues,
  desired,
}: {
  ctx: string;
  pods: KubeObject[];
  podsLoading: boolean;
  podsError: unknown;
  spec: DaemonPodSpec | undefined;
  issues: Map<string, SchedulingIssue>;
  desired: number;
}) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  // The shared watch the Nodes list uses: no extra polling of big node objects.
  const nodesList = useWatchedList([ctx], '', 'v1', 'nodes');
  const watch = nodesList.status[ctx];
  const haveNodes = nodesList.rows.length > 0;
  const nodesLoading = !haveNodes && (!watch || watch.state === 'loading');
  // A watch that isn't live and never delivered (no RBAC to list nodes, a
  // dropped connection) says so instead of pretending every node is fine.
  const nodesDown = !haveNodes && !nodesLoading && watch?.state !== 'live';
  const known = !nodesLoading && !nodesDown && !podsLoading && !podsError;
  const coverage = useMemo(() => (known ? nodeCoverage(nodesList.rows.map((r) => r.obj), pods, spec, issues) : []), [known, nodesList.rows, pods, spec, issues]);
  const attention = useMemo(() => coverage.filter((c) => c.state !== 'running' && c.state !== 'excluded'), [coverage]);
  const groups = useMemo(() => groupExclusions(coverage), [coverage]);
  const running = coverage.filter((c) => c.state === 'running').length;
  const excluded = groups.reduce((n, g) => n + g.nodes.length, 0);

  const query = filter.trim();
  const shownAttention = query ? attention.filter((c) => matchesMiniFilter(query, [c.node, c.state, c.pod?.metadata.name ?? '', c.issue?.short ?? '', ...c.exclusions])) : attention;
  const shownGroups = query
    ? groups.flatMap((g) => {
        const nodes = matchesMiniFilter(query, g.reasons) ? g.nodes : g.nodes.filter((n) => matchesMiniFilter(query, [n]));
        return nodes.length ? [{ ...g, nodes }] : [];
      })
    : groups;
  const truncated = !showAll && shownAttention.length > NODE_ROW_LIMIT;
  const visibleAttention = truncated ? shownAttention.slice(0, NODE_ROW_LIMIT) : shownAttention;

  const description = known
    ? [`${running} of ${coverage.length} running a ready pod`, attention.length ? `${attention.length} need attention` : '', excluded ? `${excluded} excluded` : ''].filter(Boolean).join(' · ')
    : undefined;

  let body: ReactNode;
  if (nodesLoading || (podsLoading && !nodesDown)) {
    body = (
      <Box sx={{ p: 1.5 }}>
        <CircularProgress size={18} />
      </Box>
    );
  } else if (nodesDown || podsError) {
    const message = nodesDown ? `Nodes unavailable: ${watch?.message ?? watch?.state ?? 'no connection'}` : `Pods unavailable: ${podsError instanceof Error ? podsError.message : String(podsError)}`;
    body = (
      <Typography variant="body2" sx={{ p: 1.5, color: statusTextColor('warning'), wordBreak: 'break-word' }}>
        {message}
      </Typography>
    );
  } else if (!coverage.length) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
        The cluster reports no nodes.
      </Typography>
    );
  } else if (!attention.length && !groups.length) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
        Every node runs a ready pod of this DaemonSet.
      </Typography>
    );
  } else {
    body = (
      <>
        <Table size="small" sx={TABLE_SX}>
          <TableHead>
            <TableRow>
              <TableCell>Node</TableCell>
              <TableCell>State</TableCell>
              <TableCell>Why</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleAttention.map((c) => (
              <NodeRow key={c.node} ctx={ctx} coverage={c} />
            ))}
            {shownGroups.map((g) =>
              g.nodes.length === 1 ? (
                <NodeRow key={g.nodes[0]} ctx={ctx} coverage={{ node: g.nodes[0]!, state: 'excluded', exclusions: g.reasons }} />
              ) : (
                <ExclusionGroupRow key={g.reasons.join('\n')} ctx={ctx} group={g} />
              ),
            )}
          </TableBody>
        </Table>
        {!shownAttention.length && !shownGroups.length && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
            No nodes match the filter.
          </Typography>
        )}
        {truncated && (
          <Stack direction="row" sx={{ px: 2, py: 1, gap: 1.5, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary">
              {`Showing ${NODE_ROW_LIMIT} of ${shownAttention.length} nodes that need attention.`}
            </Typography>
            <Button size="small" onClick={() => setShowAll(true)} sx={{ py: 0, minWidth: 0 }}>
              {`Show all ${shownAttention.length}`}
            </Button>
          </Stack>
        )}
        {running > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, py: 1 }}>
            {`${running} node${running === 1 ? '' : 's'} running a ready pod ${running === 1 ? 'is' : 'are'} listed under Pods.`}
          </Typography>
        )}
      </>
    );
  }

  return (
    <Section
      title="Nodes"
      count={known ? coverage.length : undefined}
      flush
      description={description}
      defaultOpen={(known && attention.length > 0) || desired === 0 || nodesDown || !!podsError}
      actions={attention.length + excluded > NODE_FILTER_THRESHOLD ? <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter nodes" /> : undefined}
    >
      {body}
    </Section>
  );
}

function NodeLink({ ctx, name, variant = 'body2' }: { ctx: string; name: string; variant?: 'body2' | 'caption' }) {
  const push = useDetailStore((s) => s.push);
  return (
    <Link
      component="button"
      variant={variant}
      underline="hover"
      sx={{ textAlign: 'left', verticalAlign: 'baseline', wordBreak: 'break-word' }}
      onClick={(e) => {
        e.stopPropagation();
        push({ ctx, group: '', version: 'v1', plural: 'nodes', kind: 'Node', name });
      }}
    >
      {name}
    </Link>
  );
}

function PodLink({ ctx, pod }: { ctx: string; pod: KubeObject }) {
  const push = useDetailStore((s) => s.push);
  return (
    <Link
      component="button"
      variant="caption"
      underline="hover"
      sx={{ textAlign: 'left', verticalAlign: 'baseline' }}
      onClick={(e) => {
        e.stopPropagation();
        push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace });
      }}
    >
      {pod.metadata.name}
    </Link>
  );
}

/**
 * One node that needs a word of explanation. Coverage is recomputed on every
 * pod poll; the row only renders again when what it shows has changed.
 */
const NodeRow = memo(
  function NodeRow({ ctx, coverage: c }: { ctx: string; coverage: NodeCoverage }) {
    const push = useDetailStore((s) => s.push);
    const chip = c.state === 'not-ready' ? { status: c.podStatus ?? 'Unknown', label: c.podStatus ?? 'Unknown' } : STATE_CHIP[c.state as keyof typeof STATE_CHIP];
    return (
      <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => push({ ctx, group: '', version: 'v1', plural: 'nodes', kind: 'Node', name: c.node })}>
        <TableCell sx={{ wordBreak: 'break-word', verticalAlign: 'top' }}>
          <NodeLink ctx={ctx} name={c.node} />
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
          <StatusChip status={chip.status} label={chip.label} />
        </TableCell>
        <TableCell sx={{ wordBreak: 'break-word', verticalAlign: 'top' }}>
          {c.state === 'pending' && c.pod && (
            <>
              <Typography component="span" variant="body2" sx={{ color: statusTextColor('warning'), fontWeight: 550 }}>
                {c.issue?.short}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                <PodLink ctx={ctx} pod={c.pod} /> can’t be scheduled
              </Typography>
            </>
          )}
          {c.state === 'not-ready' && c.pod && (
            <Typography variant="caption" color="text.secondary">
              <PodLink ctx={ctx} pod={c.pod} /> isn’t ready
            </Typography>
          )}
          {c.state === 'missing' && (
            <Typography component="span" variant="body2">
              Should run a pod but has none yet
            </Typography>
          )}
          {(c.state === 'excluded' || c.state === 'misscheduled') && (
            <>
              {c.exclusions.map((reason) => (
                <Typography key={reason} variant="body2" sx={{ display: 'block' }}>
                  {reason}
                </Typography>
              ))}
              {c.state === 'misscheduled' && c.pod && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  <PodLink ctx={ctx} pod={c.pod} /> runs here anyway
                </Typography>
              )}
            </>
          )}
        </TableCell>
      </TableRow>
    );
  },
  (prev, next) => prev.ctx === next.ctx && coverageKey(prev.coverage) === coverageKey(next.coverage),
);

/**
 * Nodes left out for the same reasons, as one row with the count; the names
 * are a click away, listed up to a limit.
 */
const ExclusionGroupRow = memo(
  function ExclusionGroupRow({ ctx, group }: { ctx: string; group: ExclusionGroup }) {
    const [open, setOpen] = useState(false);
    const [all, setAll] = useState(false);
    const names = all ? group.nodes : group.nodes.slice(0, GROUP_NODE_LIMIT);
    return (
      <>
        <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
          <TableCell sx={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
            <ButtonBase
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
              sx={{ gap: 0.25, typography: 'body2', fontWeight: 550, borderRadius: 0.5 }}
            >
              <KeyboardArrowRightIcon sx={{ fontSize: 16, color: 'text.secondary', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
              {`${group.nodes.length} nodes`}
            </ButtonBase>
          </TableCell>
          <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
            <StatusChip status="excluded" label="Excluded" />
          </TableCell>
          <TableCell sx={{ wordBreak: 'break-word', verticalAlign: 'top' }}>
            {group.reasons.map((reason) => (
              <Typography key={reason} variant="body2" sx={{ display: 'block' }}>
                {reason}
              </Typography>
            ))}
          </TableCell>
        </TableRow>
        {open && (
          <TableRow>
            <TableCell colSpan={3} sx={{ pt: 0.5, pb: 1 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.25, pl: 2.5 }}>
                {names.map((name) => (
                  <NodeLink key={name} ctx={ctx} name={name} variant="caption" />
                ))}
                {!all && group.nodes.length > GROUP_NODE_LIMIT && (
                  <Link component="button" variant="caption" onClick={() => setAll(true)} sx={{ fontWeight: 600 }}>
                    {`Show all ${group.nodes.length}`}
                  </Link>
                )}
              </Box>
            </TableCell>
          </TableRow>
        )}
      </>
    );
  },
  (prev, next) => prev.ctx === next.ctx && prev.group.reasons.join('\n') === next.group.reasons.join('\n') && prev.group.nodes.join('\n') === next.group.nodes.join('\n'),
);
