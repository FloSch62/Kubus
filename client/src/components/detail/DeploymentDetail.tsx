import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import type { ContainerUsage, KubeObject } from '@kubus/shared';
import { useMemo, useState } from 'react';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { SetImageDialog } from '../RowActions.js';
import { DETAIL_LIST_LIVE_MS, useResourceList, useResourceMetrics } from '../../api/queries.js';
import { containerResources, podContainerNames, podSummary, runningContainerNames, workloadReady } from '../../kube-display.js';
import { useDetailStore } from '../../state/detail.js';
import { useDockStore, dockTabId } from '../../state/dock.js';
import { showToast } from '../../state/toast.js';
import { AgeCell } from '../AgeCell.js';
import { ConditionRows, KeyValueSection, MetadataSection, hasUnhealthyCondition } from './GenericDetail.js';
import { Fact, Facts, WarnValue } from './Facts.js';
import { ContainerPanels, type ContainerPanelData } from './ContainerPanels.js';
import { mountRows, probeRows, templateEnv, type ContainerSpec, type VolumeSpec } from './container-spec.js';
import { PodMiniList } from './PodMiniList.js';
import { ProblemBanner, type ProblemItem } from './ProblemBanner.js';
import { ReplicaBar } from './ReplicaBar.js';
import { CountPill, DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';
import { gvkForKind } from '@kubus/shared';

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }>;
}

interface DeploymentSpec {
  replicas?: number;
  selector?: LabelSelector;
  paused?: boolean;
  minReadySeconds?: number;
  progressDeadlineSeconds?: number;
  revisionHistoryLimit?: number;
  strategy?: { type?: string; rollingUpdate?: { maxUnavailable?: number | string; maxSurge?: number | string } };
  template?: { spec?: { containers?: ContainerSpec[]; initContainers?: ContainerSpec[]; volumes?: VolumeSpec[]; serviceAccountName?: string } };
}

interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>;
}

interface ReplicaSetShape {
  spec?: { replicas?: number };
  status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number };
}

function selectorToString(selector: LabelSelector | undefined): string | undefined {
  if (!selector) return undefined;
  const parts = Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const expr of selector.matchExpressions ?? []) {
    if (expr.operator === 'In') parts.push(`${expr.key} in (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'NotIn') parts.push(`${expr.key} notin (${(expr.values ?? []).join(',')})`);
    else if (expr.operator === 'Exists') parts.push(expr.key);
    else if (expr.operator === 'DoesNotExist') parts.push(`!${expr.key}`);
  }
  return parts.length ? parts.join(',') : undefined;
}

function ownedBy(obj: KubeObject, uid: string | undefined): boolean {
  if (!uid) return false;
  return (obj.metadata.ownerReferences ?? []).some((owner) => owner.uid === uid && owner.controller);
}

function revisionOf(rs: KubeObject): number {
  return Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
}

// ReplicaFailure=True is the only bad-when-true Deployment condition.
const deploymentGoodWhen = (type: string): 'True' | 'False' => (type === 'ReplicaFailure' ? 'False' : 'True');

/** "2 Running · 1 ImagePullBackOff" — pod states by frequency. */
export function podStatusSummary(pods: KubeObject[]): string | undefined {
  if (!pods.length) return undefined;
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const s = podSummary(pod).status;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
}

/**
 * Why the rollout isn't complete: the failing Deployment conditions in full,
 * plus the pods' own waiting/terminated reasons grouped by state — the
 * image-pull or crash message is on the pod, not the Deployment.
 */
function rolloutProblems(status: DeploymentStatus | undefined, pods: KubeObject[]): ProblemItem[] {
  const items: ProblemItem[] = [];
  for (const c of status?.conditions ?? []) {
    const bad = c.status !== deploymentGoodWhen(c.type) && c.status !== 'Unknown';
    if (!bad) continue;
    items.push({ title: `${c.type}: ${c.reason ?? c.status}`, message: c.message, at: c.lastTransitionTime });
  }
  const groups = new Map<string, { count: number; message?: string }>();
  for (const pod of pods) {
    const summary = podSummary(pod);
    if (summary.status === 'Running' || summary.status === 'Succeeded' || summary.status === 'Completed') continue;
    const entry = groups.get(summary.status) ?? { count: 0 };
    entry.count += 1;
    if (!entry.message) {
      const st = pod.status as { containerStatuses?: Array<{ state?: { waiting?: { message?: string }; terminated?: { message?: string } } }> } | undefined;
      for (const cs of st?.containerStatuses ?? []) {
        const message = cs.state?.waiting?.message ?? cs.state?.terminated?.message;
        if (message) {
          entry.message = message;
          break;
        }
      }
    }
    groups.set(summary.status, entry);
  }
  // Neighbouring states (ErrImagePull → ImagePullBackOff) carry the same
  // message; say it once under a combined headline.
  const byMessage = new Map<string, string[]>();
  for (const [state, entry] of groups) {
    const title = `${entry.count} pod${entry.count === 1 ? '' : 's'} ${state}`;
    const key = entry.message ?? `\0${state}`;
    byMessage.set(key, [...(byMessage.get(key) ?? []), title]);
  }
  for (const [key, titles] of byMessage) {
    items.push({ title: titles.join(' · '), message: key.startsWith('\0') ? undefined : key });
  }
  return items;
}

export function DeploymentDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const [forwardPort, setForwardPort] = useState<number>();
  const [editImageContainer, setEditImageContainer] = useState<string>();
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const spec = obj.spec as DeploymentSpec | undefined;
  const dstatus = obj.status as DeploymentStatus | undefined;
  const labelSelector = selectorToString(spec?.selector);
  const enabled = !!namespace && !!labelSelector;
  // Polled while the drawer is open so a rollout can be watched from here.
  const replicaSetsQuery = useResourceList(
    enabled ? { ctx, group: 'apps', version: 'v1', plural: 'replicasets', namespace, labelSelector } : undefined,
    { liveMs: DETAIL_LIST_LIVE_MS },
  );
  const podsQuery = useResourceList(enabled ? { ctx, group: '', version: 'v1', plural: 'pods', namespace, labelSelector } : undefined, {
    liveMs: DETAIL_LIST_LIVE_MS,
  });

  const replicaSets = useMemo(
    () =>
      (replicaSetsQuery.data?.items ?? [])
        .filter((rs) => ownedBy(rs, obj.metadata.uid))
        .sort((a, b) => revisionOf(b) - revisionOf(a)),
    [obj.metadata.uid, replicaSetsQuery.data?.items],
  );
  const pods = useMemo(() => {
    const replicaSetUids = new Set(replicaSets.map((rs) => rs.metadata.uid));
    return (podsQuery.data?.items ?? [])
      .filter((pod) => (pod.metadata.ownerReferences ?? []).some((owner) => replicaSetUids.has(owner.uid) && owner.controller))
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }, [podsQuery.data?.items, replicaSets]);

  // Per-container usage summed across this Deployment's pods, with the number
  // of pods that reported each container so bars scale their denominator.
  const metricsQuery = useResourceMetrics([ctx], 'pods');
  const containerUsage = useMemo(() => {
    const totals = new Map<string, ContainerUsage & { pods: number }>();
    const snap = metricsQuery.data?.get(ctx);
    if (!snap?.available) return totals;
    const byPod = new Map(snap.items.filter((i) => i.namespace === namespace).map((i) => [i.name, i]));
    for (const pod of pods) {
      const entry = byPod.get(pod.metadata.name);
      for (const c of entry?.containers ?? []) {
        const prev = totals.get(c.name);
        if (prev) {
          prev.cpuMilli += c.cpuMilli;
          prev.memBytes += c.memBytes;
          prev.pods += 1;
        } else {
          totals.set(c.name, { name: c.name, cpuMilli: c.cpuMilli, memBytes: c.memBytes, pods: 1 });
        }
      }
    }
    return totals;
  }, [metricsQuery.data, ctx, namespace, pods]);

  // Which template containers are live somewhere, and in which pod — a shell
  // has to land in a concrete pod, so the panel offers one only when a pod is
  // actually running that container.
  const podByContainer = useMemo(() => {
    const map = new Map<string, KubeObject>();
    for (const pod of pods) {
      for (const container of runningContainerNames(pod)) {
        if (!map.has(container)) map.set(container, pod);
      }
    }
    return map;
  }, [pods]);

  const panels = useMemo(() => {
    const template = spec?.template?.spec;
    const toPanel = (c: ContainerSpec, kind?: 'init' | 'sidecar'): ContainerPanelData => {
      const usage = containerUsage.get(c.name);
      return {
        name: c.name,
        image: c.image,
        kind,
        shellable: podByContainer.has(c.name),
        ports: (c.ports ?? []).map((p) => ({ port: p.containerPort, protocol: p.protocol, name: p.name })),
        resources: containerResources(c),
        usage: usage ? { cpuMilli: usage.cpuMilli, memBytes: usage.memBytes } : undefined,
        podCount: usage?.pods,
        probes: probeRows(c, undefined, false),
        mounts: mountRows(c, template?.volumes),
        env: templateEnv(c),
        command: c.command,
        args: c.args,
        imagePullPolicy: c.imagePullPolicy,
        workingDir: c.workingDir,
      };
    };
    return [
      ...(template?.containers ?? []).map((c) => toPanel(c)),
      ...(template?.initContainers ?? []).map((c) => toPanel(c, c.restartPolicy === 'Always' ? 'sidecar' : 'init')),
    ];
  }, [spec, containerUsage, podByContainer]);

  // One container's logs across every pod of this Deployment — the picker
  // still lists the rest, they just start unselected.
  const addTab = useDockStore((s) => s.addTab);
  const openContainerLogs = (container: string) => {
    if (!pods.length) {
      showToast('error', `No running pods for ${obj.metadata.name}`);
      return;
    }
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: `logs: ${obj.metadata.name}/${container}`,
      ctx,
      namespace: namespace ?? '',
      pods: pods.map((pod) => pod.metadata.name),
      sources: pods.map((pod) => ({ pod: pod.metadata.name, containers: podContainerNames(pod) })),
      target: { kind: 'Deployment', name: obj.metadata.name },
      container,
      follow: true,
    });
  };

  // Any pod running the container will do — the tab title names the one you
  // landed in, and the Pods section below is there to pick a specific one.
  const openContainerShell = (container: string) => {
    const pod = podByContainer.get(container);
    if (!pod) {
      showToast('error', `No running pod for container ${container}`);
      return;
    }
    addTab({
      kind: 'terminal',
      id: dockTabId(),
      title: `sh: ${pod.metadata.name}/${container}`,
      ctx,
      namespace: namespace ?? '',
      pod: pod.metadata.name,
      container,
    });
  };

  const openRef = (kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim', name: string) => {
    const gvk = gvkForKind(kind);
    if (!gvk) return;
    push({ ctx, group: gvk.group, version: gvk.version, plural: gvk.plural, kind, name, namespace });
  };
  const openReplicaSet = (rs: KubeObject) =>
    push({ ctx, group: 'apps', version: 'v1', plural: 'replicasets', kind: 'ReplicaSet', name: rs.metadata.name, namespace });

  const strategy = spec?.strategy?.type;
  const rolling = spec?.strategy?.rollingUpdate;
  const conditions = dstatus?.conditions ?? [];
  const desired = spec?.replicas ?? dstatus?.replicas ?? 0;
  const ready = dstatus?.readyReplicas ?? 0;
  const problems = useMemo(() => (desired > 0 && ready < desired ? rolloutProblems(dstatus, pods) : []), [desired, ready, dstatus, pods]);
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
          { label: 'Unavailable', value: String(dstatus?.unavailableReplicas ?? 0), tone: dstatus?.unavailableReplicas ? 'warning' : undefined },
        ]}
      />
      <ReplicaBar desired={desired} ready={ready} total={dstatus?.replicas ?? 0} updated={dstatus?.updatedReplicas ?? 0} paused={spec?.paused} />
      {problems.length > 0 && (
        <ProblemBanner severity={ready === 0 ? 'error' : 'warning'} title="Why this Deployment isn’t ready" items={problems} />
      )}
      <Section title="Containers" count={panels.length} flush description="pod template">
        <ContainerPanels
          items={panels}
          onLogs={openContainerLogs}
          onShell={openContainerShell}
          onForwardPort={setForwardPort}
          onEditImage={setEditImageContainer}
          onOpenRef={openRef}
        />
      </Section>
      <Section
        title="Pods"
        count={pods.length}
        flush
        description={podsQuery.isLoading || replicaSetsQuery.isLoading ? undefined : podStatusSummary(pods)}
      >
        <PodMiniList
          ctx={ctx}
          pods={pods}
          loading={replicaSetsQuery.isLoading || podsQuery.isLoading}
          emptyText={labelSelector ? 'No pods owned by this Deployment.' : 'No selector on this Deployment.'}
          hideNamespace
        />
      </Section>
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
      {forwardPort !== undefined && (
        <PortForwardDialog ctx={ctx} kind="Deployment" obj={obj} initialRemotePort={forwardPort} onClose={() => setForwardPort(undefined)} />
      )}
      {editImageContainer !== undefined && (
        <SetImageDialog
          target={{ ctx, group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', obj }}
          initialContainer={editImageContainer}
          onClose={() => setEditImageContainer(undefined)}
          onDone={(t) => showToast('success', t)}
          onError={(e) => showToast('error', e instanceof Error ? e.message : String(e))}
        />
      )}
    </DetailStack>
  );
}

