import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import type { KubeObject } from '@kubus/shared';
import { useMemo } from 'react';
import { DETAIL_LIST_LIVE_MS, useResourceList } from '../../api/queries.js';
import { workloadReady } from '../../kube-display.js';
import { useDetailStore } from '../../state/detail.js';
import { AgeCell } from '../AgeCell.js';
import { ConditionRows, KeyValueSection, MetadataSection, hasUnhealthyCondition } from './GenericDetail.js';
import { Fact, Facts, WarnValue } from './Facts.js';
import { ProblemBanner } from './ProblemBanner.js';
import { ReplicaBar } from './ReplicaBar.js';
import { CountPill, DetailStack, Section } from './Section.js';
import { labelSelectorToString, type LabelSelector } from './selectors.js';
import { SummaryStrip } from './SummaryStrip.js';
import { UsedBySection } from './UsedBySection.js';
import { controlledBy, useSelectorPods, useWorkloadProblems, WorkloadContainers, WorkloadPods, type PodTemplateSpec } from './WorkloadParts.js';
import type { Condition } from './workload-problems.js';
import { naturalCompare } from '../natural-sort.js';

interface DeploymentSpec {
  replicas?: number;
  selector?: LabelSelector;
  paused?: boolean;
  minReadySeconds?: number;
  progressDeadlineSeconds?: number;
  revisionHistoryLimit?: number;
  strategy?: { type?: string; rollingUpdate?: { maxUnavailable?: number | string; maxSurge?: number | string } };
  template?: { spec?: PodTemplateSpec };
}

interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Condition[];
}

interface ReplicaSetShape {
  spec?: { replicas?: number };
  status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number };
}

function revisionOf(rs: KubeObject): number {
  return Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
}

const SELECTOR_KINDS = ['Service', 'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'NetworkPolicy'];

// ReplicaFailure=True is the only bad-when-true Deployment condition.
const deploymentGoodWhen = (type: string): 'True' | 'False' => (type === 'ReplicaFailure' ? 'False' : 'True');

export function DeploymentDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const spec = obj.spec as DeploymentSpec | undefined;
  const dstatus = obj.status as DeploymentStatus | undefined;
  const labelSelector = labelSelectorToString(spec?.selector) || undefined;
  const enabled = !!namespace && !!labelSelector;
  // Polled while the drawer is open so a rollout can be watched from here.
  const replicaSetsQuery = useResourceList(
    enabled ? { ctx, group: 'apps', version: 'v1', plural: 'replicasets', namespace, labelSelector } : undefined,
    { liveMs: DETAIL_LIST_LIVE_MS },
  );
  const podsQuery = useSelectorPods(ctx, namespace, labelSelector);

  const replicaSets = useMemo(
    () =>
      (replicaSetsQuery.data?.items ?? [])
        .filter((rs) => controlledBy(rs, new Set([obj.metadata.uid])))
        .sort((a, b) => revisionOf(b) - revisionOf(a)),
    [obj.metadata.uid, replicaSetsQuery.data?.items],
  );
  const pods = useMemo(() => {
    const replicaSetUids = new Set(replicaSets.map((rs) => rs.metadata.uid));
    return (podsQuery.data?.items ?? []).filter((pod) => controlledBy(pod, replicaSetUids)).sort((a, b) => naturalCompare(a.metadata.name, b.metadata.name));
  }, [podsQuery.data?.items, replicaSets]);

  const openReplicaSet = (rs: KubeObject) =>
    push({ ctx, group: 'apps', version: 'v1', plural: 'replicasets', kind: 'ReplicaSet', name: rs.metadata.name, namespace });

  const strategy = spec?.strategy?.type;
  const rolling = spec?.strategy?.rollingUpdate;
  const conditions = dstatus?.conditions ?? [];
  const desired = spec?.replicas ?? dstatus?.replicas ?? 0;
  const ready = dstatus?.readyReplicas ?? 0;
  // Failing conditions in full, plus the pods' own reasons: the image-pull,
  // crash or scheduling message is on the pod, not the Deployment. "exceeded
  // quota: <name>" in a ReplicaFailure message links to that quota.
  const { problems, issues } = useWorkloadProblems({
    ctx,
    kind: 'Deployment',
    obj,
    pods,
    active: desired > 0 && ready < desired,
    conditions: dstatus?.conditions,
    goodWhen: deploymentGoodWhen,
  });
  const readyTone = desired === 0 ? undefined : ready >= desired ? 'success' : ready === 0 ? 'error' : 'warning';
  // Old ReplicaSets scaled to zero are history (the History tab has them
  // with images and rollback); the overview shows what holds pods now.
  const currentRevision = replicaSets.length ? revisionOf(replicaSets[0]!) : undefined;
  const liveReplicaSets = replicaSets.filter((rs, i) => i === 0 || ((rs as ReplicaSetShape).spec?.replicas ?? 0) > 0 || ((rs as ReplicaSetShape).status?.replicas ?? 0) > 0);
  const hiddenReplicaSets = replicaSets.length - liveReplicaSets.length;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Ready', value: workloadReady(obj), tone: readyTone },
          { label: 'Updated', value: String(dstatus?.updatedReplicas ?? 0), hint: 'Replicas running the current pod template.' },
          { label: 'Available', value: String(dstatus?.availableReplicas ?? 0), hint: 'Replicas ready for at least minReadySeconds.' },
          // Same fact as Ready from the other side, so the same tone: red when nothing is up.
          { label: 'Unavailable', value: String(dstatus?.unavailableReplicas ?? 0), tone: dstatus?.unavailableReplicas ? (ready === 0 ? 'error' : 'warning') : undefined },
        ]}
      />
      <ReplicaBar desired={desired} ready={ready} total={dstatus?.replicas ?? 0} updated={dstatus?.updatedReplicas ?? 0} paused={spec?.paused} />
      {problems.length > 0 && (
        <ProblemBanner severity={ready === 0 ? 'error' : 'warning'} title="Why this Deployment isn’t ready" items={problems} />
      )}
      <WorkloadContainers ctx={ctx} kind="Deployment" obj={obj} pods={pods} template={spec?.template?.spec} />
      <WorkloadPods
        ctx={ctx}
        pods={pods}
        loading={replicaSetsQuery.isLoading || podsQuery.isLoading}
        emptyText={labelSelector ? 'No pods owned by this Deployment.' : 'No selector on this Deployment.'}
        issues={issues}
      />
      {liveReplicaSets.length > 0 && (
        <Section
          title="Replica sets"
          count={liveReplicaSets.length}
          flush
          defaultOpen={liveReplicaSets.length > 1}
          description={hiddenReplicaSets > 0 ? `${hiddenReplicaSets} older scaled to zero — see History` : currentRevision ? `revision ${currentRevision}` : undefined}
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Revision</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Ready</TableCell>
                <TableCell>Age</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {liveReplicaSets.map((rs) => {
                const shape = rs as ReplicaSetShape;
                const rsDesired = shape.spec?.replicas ?? 0;
                const rsReady = shape.status?.readyReplicas ?? 0;
                const current = revisionOf(rs) === currentRevision;
                return (
                  <TableRow key={rs.metadata.uid} hover sx={{ cursor: 'pointer' }} onClick={() => openReplicaSet(rs)}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
                        {revisionOf(rs) || '—'}
                        {current && <CountPill value="current" sx={{ color: 'primary.main', bgcolor: (t) => `${t.palette.primary.main}1a` }} />}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      <Link component="button" variant="body2" underline="hover" sx={{ textAlign: 'left', verticalAlign: 'baseline' }} onClick={(e) => { e.stopPropagation(); openReplicaSet(rs); }}>
                        {rs.metadata.name}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Box component="span" sx={{ color: rsDesired > 0 && rsReady < rsDesired ? (t) => (t.palette.mode === 'dark' ? t.palette.warning.main : t.palette.warning.dark) : 'inherit' }}>
                        {rsReady}/{rsDesired}
                      </Box>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <AgeCell timestamp={rs.metadata.creationTimestamp} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      )}
      <UsedBySection
        target={{ ctx, group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', name: obj.metadata.name, namespace }}
        title="Selected by"
        kinds={SELECTOR_KINDS}
        emptyText="No Service, autoscaler, PodDisruptionBudget or NetworkPolicy selects this Deployment's pods."
        defaultOpen={false}
      />
      <Section title="Details">
        <Facts>
          <Fact label="Selector" mono>
            {labelSelector}
          </Fact>
          <Fact label="Strategy">
            {strategy && (
              <>
                {strategy}
                {rolling && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {` · max unavailable ${rolling.maxUnavailable ?? '-'} · max surge ${rolling.maxSurge ?? '-'}`}
                  </Box>
                )}
              </>
            )}
          </Fact>
          <Fact label="Rollout">{spec?.paused && <WarnValue>Paused</WarnValue>}</Fact>
          <Fact label="Min ready" hint="Seconds a new pod must be ready before it counts as available.">
            {spec?.minReadySeconds !== undefined ? `${spec.minReadySeconds}s` : undefined}
          </Fact>
          <Fact label="Progress deadline" hint="Seconds without progress before the rollout is reported as stalled.">
            {spec?.progressDeadlineSeconds !== undefined ? `${spec.progressDeadlineSeconds}s` : undefined}
          </Fact>
          <Fact label="History limit" hint="Old ReplicaSets kept for rollback.">
            {spec?.revisionHistoryLimit !== undefined ? String(spec.revisionHistoryLimit) : undefined}
          </Fact>
          <Fact label="Service account">{spec?.template?.spec?.serviceAccountName}</Fact>
        </Facts>
      </Section>
      {conditions.length > 0 && (
        <Section title="Conditions" count={conditions.length} flush defaultOpen={hasUnhealthyCondition(obj, deploymentGoodWhen)}>
          <ConditionRows conditions={conditions} goodWhen={deploymentGoodWhen} />
        </Section>
      )}
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}
