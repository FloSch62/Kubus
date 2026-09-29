import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { useMemo, useState } from 'react';
import { DETAIL_LIST_LIVE_MS, isResourceGone, useResource, useResourceList } from '../../api/queries.js';
import { workloadReady } from '../../kube-display.js';
import { useDetailStore } from '../../state/detail.js';
import { statusTextColor } from '../../theme.js';
import { MiniFilterInput, matchesMiniFilter } from '../MiniFilterInput.js';
import { StatusChip } from '../StatusChip.js';
import { ControllerRevisions } from './ControllerRevisions.js';
import { Fact, FactLink, Facts, WarnValue } from './Facts.js';
import { ConditionsTable, KeyValueSection, MetadataSection } from './GenericDetail.js';
import { ProblemBanner } from './ProblemBanner.js';
import { ReplicaBar } from './ReplicaBar.js';
import { DetailStack, Section } from './Section.js';
import { labelSelectorToString, type LabelSelector } from './selectors.js';
import { claimRows, sortByOrdinal, type ClaimRow, type StatefulSetSpecShape } from './statefulset.js';
import { SummaryStrip } from './SummaryStrip.js';
import { UsedBySection } from './UsedBySection.js';
import { controlledBy, useSelectorPods, useWorkloadProblems, WorkloadContainers, WorkloadPods, type PodTemplateSpec } from './WorkloadParts.js';

interface StatefulSetSpec extends StatefulSetSpecShape {
  selector?: LabelSelector;
  podManagementPolicy?: string;
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
  updateStrategy?: { type?: string; rollingUpdate?: { partition?: number; maxUnavailable?: number | string } };
  persistentVolumeClaimRetentionPolicy?: { whenDeleted?: string; whenScaled?: string };
  template?: { spec?: PodTemplateSpec };
}

interface StatefulSetStatus {
  replicas?: number;
  readyReplicas?: number;
  currentReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  currentRevision?: string;
  updateRevision?: string;
}

const SELECTOR_KINDS = ['Service', 'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'NetworkPolicy'];

/** Rows a claims table needs before it grows a filter box. */
const CLAIM_FILTER_THRESHOLD = 8;

/** "5 Bound · 1 Pending" — claim phases by frequency, missing claims counted as "not created". */
function claimSummary(rows: ClaimRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.phase ?? 'not created', (counts.get(r.phase ?? 'not created') ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([phase, n]) => `${n} ${phase}`)
    .join(' · ');
}

export function StatefulSetDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const name = obj.metadata.name;
  const spec = obj.spec as StatefulSetSpec | undefined;
  const status = obj.status as StatefulSetStatus | undefined;
  const labelSelector = labelSelectorToString(spec?.selector) || undefined;
  const podsQuery = useSelectorPods(ctx, namespace, labelSelector);
  const pods = useMemo(
    () => sortByOrdinal((podsQuery.data?.items ?? []).filter((pod) => controlledBy(pod, new Set([obj.metadata.uid]))), name),
    [podsQuery.data?.items, obj.metadata.uid, name],
  );

  const hasClaims = !!spec?.volumeClaimTemplates?.length;
  const pvcsQuery = useResourceList(hasClaims && namespace ? { ctx, group: '', version: 'v1', plural: 'persistentvolumeclaims', namespace } : undefined, {
    liveMs: DETAIL_LIST_LIVE_MS,
  });
  const claims = useMemo(() => claimRows(obj, pvcsQuery.data?.items ?? []), [obj, pvcsQuery.data?.items]);

  // The governing Service gives every pod its stable DNS name, and only does
  // so when it is headless.
  const serviceName = spec?.serviceName;
  const serviceQuery = useResource(serviceName && namespace ? { ctx, group: '', version: 'v1', plural: 'services', kind: 'Service', name: serviceName, namespace } : undefined);
  const serviceClusterIp = (serviceQuery.data?.spec as { clusterIP?: string } | undefined)?.clusterIP;

  const desired = spec?.replicas ?? status?.replicas ?? 0;
  const ready = status?.readyReplicas ?? 0;
  const updated = status?.updatedReplicas ?? 0;
  const partition = spec?.updateStrategy?.rollingUpdate?.partition ?? 0;
  const onDelete = spec?.updateStrategy?.type === 'OnDelete';
  const { problems, issues } = useWorkloadProblems({ ctx, kind: 'StatefulSet', obj, pods, active: desired > 0 && ready < desired });
  const readyTone = desired === 0 ? undefined : ready >= desired ? 'success' : ready === 0 ? 'error' : 'warning';
  const start = spec?.ordinals?.start ?? 0;
  const bound = claims.filter((c) => !c.retained && c.phase === 'Bound').length;
  const expectedClaims = claims.filter((c) => !c.retained).length;
  const rolling = spec?.updateStrategy?.rollingUpdate;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Ready', value: workloadReady(obj), tone: readyTone },
          { label: 'Updated', value: `${updated}/${desired}`, hint: 'Pods running the update revision of the pod template.' },
          { label: 'Available', value: String(status?.availableReplicas ?? 0), hint: 'Pods ready for at least minReadySeconds.' },
          hasClaims && {
            label: 'Claims bound',
            value: pvcsQuery.isLoading ? '…' : `${bound}/${expectedClaims}`,
            tone: pvcsQuery.isLoading || !expectedClaims ? undefined : bound === expectedClaims ? 'success' : 'warning',
            hint: 'PersistentVolumeClaims from the volume claim templates that are bound to a volume.',
          },
          partition > 0 && { label: 'Partition', value: String(partition), hint: `Ordinals below ${partition} stay on the old revision during a rolling update.` },
        ]}
      />
      <ReplicaBar
        desired={desired}
        ready={ready}
        total={status?.replicas ?? 0}
        updated={updated}
        note={partition > 0 ? `partition ${partition}` : onDelete ? 'OnDelete: pods update when deleted' : undefined}
      />
      {problems.length > 0 && <ProblemBanner severity={ready === 0 ? 'error' : 'warning'} title="Why this StatefulSet isn’t ready" items={problems} />}
      <WorkloadContainers ctx={ctx} kind="StatefulSet" obj={obj} pods={pods} template={spec?.template?.spec} />
      <WorkloadPods
        ctx={ctx}
        pods={pods}
        loading={podsQuery.isLoading}
        emptyText={labelSelector ? 'No pods owned by this StatefulSet.' : 'No selector on this StatefulSet.'}
        issues={issues}
      />
      {hasClaims && <ClaimsSection ctx={ctx} namespace={namespace} rows={claims} loading={pvcsQuery.isLoading} />}
      <ControllerRevisions ctx={ctx} obj={obj} pods={pods} labelSelector={labelSelector} updateRevision={status?.updateRevision} />
      <UsedBySection
        target={{ ctx, group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet', name, namespace }}
        title="Selected by"
        kinds={SELECTOR_KINDS}
        emptyText="No Service, autoscaler, PodDisruptionBudget or NetworkPolicy selects this StatefulSet's pods."
        defaultOpen={false}
      />
      <Section title="Details">
        <Facts>
          <Fact label="Service" hint="The governing Service. When it is headless, each pod gets a stable DNS name through it.">
            {serviceName && (
              <>
                <FactLink title={`Open Service ${serviceName}`} onClick={() => push({ ctx, group: '', version: 'v1', plural: 'services', kind: 'Service', name: serviceName, namespace })}>
                  {serviceName}
                </FactLink>
                {serviceQuery.data && serviceClusterIp === 'None' && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {' · headless'}
                  </Box>
                )}
                {serviceQuery.data && serviceClusterIp !== 'None' && (
                  <>
                    {' · '}
                    <WarnValue>{`not headless (cluster IP ${serviceClusterIp ?? 'unset'})`}</WarnValue>
                  </>
                )}
                {isResourceGone(serviceQuery.error) && (
                  <>
                    {' · '}
                    <WarnValue>not found</WarnValue>
                  </>
                )}
              </>
            )}
          </Fact>
          <Fact label="Pod DNS" mono hint="Stable per-pod names served by the headless Service.">
            {serviceName && namespace && desired > 0 && (serviceQuery.data ? serviceClusterIp === 'None' : !isResourceGone(serviceQuery.error))
              ? `${name}-{${start}..${start + desired - 1}}.${serviceName}.${namespace}.svc.cluster.local`
              : undefined}
          </Fact>
          <Fact label="Selector" mono>
            {labelSelector}
          </Fact>
          <Fact label="Update strategy">
            {spec?.updateStrategy?.type && (
              <>
                {spec.updateStrategy.type}
                {/* Partition 0 is the API default and means "update everything". */}
                {rolling && (!!rolling.partition || rolling.maxUnavailable !== undefined) && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {[rolling.partition ? ` · partition ${rolling.partition}` : '', rolling.maxUnavailable !== undefined ? ` · max unavailable ${rolling.maxUnavailable}` : ''].join('')}
                  </Box>
                )}
              </>
            )}
          </Fact>
          <Fact label="Pod management" hint="OrderedReady starts and stops pods one ordinal at a time; Parallel does them all at once.">
            {spec?.podManagementPolicy}
          </Fact>
          <Fact label="Revision" hint="The revision pods are updated to, and the one the older pods still run.">
            {status?.updateRevision && (
              <>
                {status.updateRevision}
                {status.currentRevision && status.currentRevision !== status.updateRevision && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {` · ${status.currentReplicas ?? 0} still on ${status.currentRevision}`}
                  </Box>
                )}
              </>
            )}
          </Fact>
          <Fact label="Claim retention" hint="What happens to the volume claims when the StatefulSet is deleted or scaled down.">
            {spec?.persistentVolumeClaimRetentionPolicy &&
              `deleted: ${spec.persistentVolumeClaimRetentionPolicy.whenDeleted ?? 'Retain'} · scaled down: ${spec.persistentVolumeClaimRetentionPolicy.whenScaled ?? 'Retain'}`}
          </Fact>
          <Fact label="Ordinals">{start !== 0 ? `start at ${start}` : undefined}</Fact>
          <Fact label="Min ready" hint="Seconds a new pod must be ready before it counts as available.">
            {spec?.minReadySeconds !== undefined ? `${spec.minReadySeconds}s` : undefined}
          </Fact>
          <Fact label="History limit" hint="Old revisions kept for rollback.">
            {spec?.revisionHistoryLimit !== undefined ? String(spec.revisionHistoryLimit) : undefined}
          </Fact>
          <Fact label="Service account">{spec?.template?.spec?.serviceAccountName}</Fact>
        </Facts>
      </Section>
      <ConditionsTable obj={obj} defaultOpen={false} />
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}

/** One row per volumeClaimTemplate × ordinal: the claim, its phase and its size. */
function ClaimsSection({ ctx, namespace, rows, loading }: { ctx: string; namespace: string | undefined; rows: ClaimRow[]; loading: boolean }) {
  const push = useDetailStore((s) => s.push);
  const [filter, setFilter] = useState('');
  const shown = rows.filter((r) => matchesMiniFilter(filter, [r.claimName, r.template, String(r.ordinal), r.phase ?? 'not created', r.retained ? 'retained' : '']));
  const openClaim = (name: string) => push({ ctx, group: '', version: 'v1', plural: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim', name, namespace });
  const retained = rows.filter((r) => r.retained).length;
  // One storage class for every claim is the norm: say it once in the header.
  const classes = new Set(rows.map((r) => r.storageClass).filter(Boolean));
  const sharedClass = classes.size === 1 ? [...classes][0] : undefined;
  const description = loading ? undefined : [claimSummary(rows.filter((r) => !r.retained)), retained ? `${retained} retained` : '', sharedClass ?? ''].filter(Boolean).join(' · ');
  return (
    <Section
      title="Volume claims"
      count={loading ? undefined : rows.length}
      flush
      description={description}
      actions={rows.length > CLAIM_FILTER_THRESHOLD ? <MiniFilterInput value={filter} onChange={setFilter} placeholder="Filter claims" /> : undefined}
    >
      <Table size="small" sx={{ '& th, & td': { px: 1 }, '& th:first-of-type, & td:first-of-type': { pl: 2 } }}>
        <TableHead>
          <TableRow>
            <TableCell>Ordinal</TableCell>
            <TableCell>Claim</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Capacity</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.map((r) => (
            <TableRow key={r.claimName} hover={!!r.pvc} sx={{ cursor: r.pvc ? 'pointer' : 'default' }} onClick={r.pvc ? () => openClaim(r.claimName) : undefined}>
              <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top', color: r.retained ? 'text.secondary' : 'inherit' }}>
                {r.ordinal}
                {r.retained && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    retained
                  </Typography>
                )}
              </TableCell>
              <TableCell sx={{ wordBreak: 'break-word', verticalAlign: 'top' }}>
                {r.pvc ? (
                  <Link
                    component="button"
                    variant="body2"
                    underline="hover"
                    sx={{ textAlign: 'left', verticalAlign: 'baseline' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openClaim(r.claimName);
                    }}
                  >
                    {r.claimName}
                  </Link>
                ) : (
                  <Typography component="span" variant="body2" color="text.secondary">
                    {r.claimName}
                  </Typography>
                )}
                {r.storageClass && !sharedClass && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {r.storageClass}
                  </Typography>
                )}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                {loading ? (
                  ''
                ) : r.phase ? (
                  <StatusChip status={r.phase} />
                ) : (
                  <Typography component="span" variant="caption" sx={{ color: statusTextColor('warning'), fontWeight: 550 }}>
                    not created
                  </Typography>
                )}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>{r.capacity ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {shown.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
          No claims match the filter.
        </Typography>
      )}
    </Section>
  );
}
