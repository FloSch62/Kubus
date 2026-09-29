import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { useMemo, useState } from 'react';
import { useWatchedList } from '../../api/queries.js';
import { useDetailStore } from '../../state/detail.js';
import { statusTextColor } from '../../theme.js';
import { MiniFilterInput, matchesMiniFilter } from '../MiniFilterInput.js';
import { naturalCompare } from '../natural-sort.js';
import { StatusChip } from '../StatusChip.js';
import { ControllerRevisions } from './ControllerRevisions.js';
import { nodeCoverage, type DaemonPodSpec, type NodeCoverage, type Toleration } from './daemon-placement.js';
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
      <NodesSection ctx={ctx} pods={pods} spec={template} issues={issues} desired={desired} />
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

/**
 * Every node that is not running a ready pod of this DaemonSet, and why: the
 * scheduler's answer for a pod stuck Pending there, the selector, affinity
 * or taint that leaves the node out, or a pod on a node it no longer fits.
 */
function NodesSection({ ctx, pods, spec, issues, desired }: { ctx: string; pods: KubeObject[]; spec: DaemonPodSpec | undefined; issues: Map<string, SchedulingIssue>; desired: number }) {
  const push = useDetailStore((s) => s.push);
  const [filter, setFilter] = useState('');
  // The shared watch the Nodes list uses: no extra polling of big node objects.
  const nodesList = useWatchedList([ctx], '', 'v1', 'nodes');
  const loading = !nodesList.rows.length && nodesList.status[ctx]?.state === 'loading';
  const coverage = useMemo(() => nodeCoverage(nodesList.rows.map((r) => r.obj), pods, spec, issues), [nodesList.rows, pods, spec, issues]);
  const running = coverage.filter((c) => c.state === 'running').length;
  const needsAttention = coverage.filter((c) => c.state === 'pending' || c.state === 'missing' || c.state === 'not-ready' || c.state === 'misscheduled').length;
  const excluded = coverage.filter((c) => c.state === 'excluded').length;
  const rows = coverage.filter((c) => c.state !== 'running');
  const shown = rows.filter((c) => matchesMiniFilter(filter, [c.node, c.state, c.pod?.metadata.name ?? '', c.issue?.short ?? '', ...c.exclusions]));
  const openNode = (name: string) => push({ ctx, group: '', version: 'v1', plural: 'nodes', kind: 'Node', name });
  const openPod = (pod: KubeObject) => push({ ctx, group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: pod.metadata.name, namespace: pod.metadata.namespace });
  const description = loading
    ? undefined
    : [`${running} of ${coverage.length} running a ready pod`, needsAttention ? `${needsAttention} need attention` : '', excluded ? `${excluded} excluded` : ''].filter(Boolean).join(' · ');

  const podLink = (pod: KubeObject, variant: 'body2' | 'caption' = 'body2') => (
    <Link
      component="button"
      variant={variant}
      underline="hover"
      sx={{ textAlign: 'left', verticalAlign: 'baseline' }}
      onClick={(e) => {
        e.stopPropagation();
        openPod(pod);
      }}
    >
      {pod.metadata.name}
    </Link>
  );

  return (
    <Section
      title="Nodes"
      count={loading ? undefined : coverage.length}
      flush
      description={description}
      defaultOpen={needsAttention > 0 || desired === 0}
      actions={rows.length > NODE_FILTER_THRESHOLD ? <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter nodes" /> : undefined}
    >
      {loading ? (
        <Box sx={{ p: 1.5 }}>
          <CircularProgress size={18} />
        </Box>
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
          Every node runs a ready pod of this DaemonSet.
        </Typography>
      ) : (
        <>
          <Table size="small" sx={{ '& th, & td': { px: 1 }, '& th:first-of-type, & td:first-of-type': { pl: 2 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Node</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Why</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((c) => {
                const chip = c.state === 'not-ready' ? { status: c.podStatus ?? 'Unknown', label: c.podStatus ?? 'Unknown' } : STATE_CHIP[c.state as keyof typeof STATE_CHIP];
                return (
                  <TableRow key={c.node} hover sx={{ cursor: 'pointer' }} onClick={() => openNode(c.node)}>
                    <TableCell sx={{ wordBreak: 'break-word', verticalAlign: 'top' }}>
                      <Link
                        component="button"
                        variant="body2"
                        underline="hover"
                        sx={{ textAlign: 'left', verticalAlign: 'baseline' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openNode(c.node);
                        }}
                      >
                        {c.node}
                      </Link>
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
                            {podLink(c.pod, 'caption')} can’t be scheduled
                          </Typography>
                        </>
                      )}
                      {c.state === 'not-ready' && c.pod && <>{podLink(c.pod)} isn’t ready</>}
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
                              {podLink(c.pod, 'caption')} runs here anyway
                            </Typography>
                          )}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {shown.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
              No nodes match the filter.
            </Typography>
          )}
          {running > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, py: 1 }}>
              {`${running} node${running === 1 ? '' : 's'} running a ready pod ${running === 1 ? 'is' : 'are'} listed under Pods.`}
            </Typography>
          )}
        </>
      )}
    </Section>
  );
}
