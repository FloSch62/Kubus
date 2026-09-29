import { useMemo, useState } from 'react';
import type { ContainerUsage, KubeObject, ObjectSignal } from '@kubus/shared';
import { gvkForKind } from '@kubus/shared';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { SetImageDialog } from '../RowActions.js';
import { DETAIL_LIST_LIVE_MS, useClusterSignals, useResourceList, useResourceMetrics } from '../../api/queries.js';
import { containerResources, podContainerNames, runningContainerNames } from '../../kube-display.js';
import { useDetailStore } from '../../state/detail.js';
import { useDockStore, dockTabId } from '../../state/dock.js';
import { showToast } from '../../state/toast.js';
import { ContainerPanels, type ContainerPanelData } from './ContainerPanels.js';
import { mountRows, probeRows, templateEnv, type ContainerSpec, type VolumeRefKind, type VolumeSpec } from './container-spec.js';
import type { EnvRefKind } from './EnvTable.js';
import { PodMiniList } from './PodMiniList.js';
import type { ProblemItem } from './ProblemBanner.js';
import { problemLinksFor } from './quota-link.js';
import { podSchedulingIssue, type SchedulingIssue } from './scheduling.js';
import { Section } from './Section.js';
import { conditionProblems, controllerEventProblems, podProblems, podStatusSummary, type Condition } from './workload-problems.js';

/**
 * The parts every workload overview (Deployment, StatefulSet, DaemonSet) is
 * built from: the pods it controls, its pod template as container panels
 * with logs, shell, port forward and set image, the pod table, and the
 * problem banner's items with links. Each overview adds what is specific to
 * its kind around them.
 */

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

const PLURALS: Record<WorkloadKind, string> = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' };

export interface PodTemplateSpec {
  containers?: ContainerSpec[];
  initContainers?: ContainerSpec[];
  volumes?: VolumeSpec[];
  serviceAccountName?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{ key?: string; operator?: string; value?: string; effect?: string }>;
  affinity?: Record<string, unknown>;
  hostNetwork?: boolean;
}

/** Whether `uid` is the object's controlling owner. */
export function controlledBy(obj: KubeObject, uids: ReadonlySet<string | undefined>): boolean {
  return (obj.metadata.ownerReferences ?? []).some((owner) => owner.controller && uids.has(owner.uid));
}

/**
 * The namespace's pods matching a workload selector, polled while the drawer
 * is open so a rollout can be watched from here. Callers narrow the result
 * to the pods their controller actually owns.
 */
export function useSelectorPods(ctx: string, namespace: string | undefined, labelSelector: string | undefined) {
  return useResourceList(namespace && labelSelector ? { ctx, group: '', version: 'v1', plural: 'pods', namespace, labelSelector } : undefined, {
    liveMs: DETAIL_LIST_LIVE_MS,
  });
}

interface WorkloadProblemsInput {
  ctx: string;
  kind: WorkloadKind;
  obj: KubeObject;
  pods: KubeObject[];
  /** Only a workload short of ready replicas gets a banner. */
  active: boolean;
  conditions?: Condition[];
  goodWhen?: (type: string) => 'True' | 'False';
}

/**
 * Banner items and per-pod scheduling issues for a workload. Reads the
 * cluster signals (the pinned event cache behind the Overview's warnings)
 * so a Pending pod's latest FailedScheduling event and the controller's own
 * create failures reach the drawer.
 */
export function useWorkloadProblems({ ctx, kind, obj, pods, active, conditions, goodWhen }: WorkloadProblemsInput): { problems: ProblemItem[]; issues: Map<string, SchedulingIssue> } {
  const push = useDetailStore((s) => s.push);
  const namespace = obj.metadata.namespace;
  const signalsQuery = useClusterSignals(active ? [ctx] : []);
  const signals = signalsQuery.data?.get(ctx);
  return useMemo(() => {
    const warningsFor = (k: string, name: string): ObjectSignal['warnings'] | undefined => signals?.objects[`${k}|${namespace ?? ''}|${name}`]?.warnings;
    const issues = new Map<string, SchedulingIssue>();
    for (const pod of pods) {
      const issue = podSchedulingIssue(pod, warningsFor('Pod', pod.metadata.name));
      if (issue) issues.set(pod.metadata.uid, issue);
    }
    if (!active) return { problems: [], issues };
    const items = [
      ...(conditions && goodWhen ? conditionProblems(conditions, goodWhen) : []),
      // A Deployment reports refused pods as ReplicaFailure; the others only as events.
      ...(kind === 'Deployment' ? [] : controllerEventProblems(warningsFor(kind, obj.metadata.name))),
      ...podProblems(pods, warningsFor),
    ];
    const problems = items.map(({ nodes, ...item }) => ({ ...item, links: problemLinksFor(item.message, nodes, namespace, (selection) => push(selection(ctx))) }));
    return { problems, issues };
  }, [signals, pods, active, conditions, goodWhen, kind, obj.metadata.name, namespace, ctx, push]);
}

/**
 * Per-container usage summed across the workload's pods, with the number of
 * pods that reported each container so bars scale their denominator.
 */
function useContainerUsage(ctx: string, namespace: string | undefined, pods: KubeObject[]) {
  const metricsQuery = useResourceMetrics([ctx], 'pods');
  return useMemo(() => {
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
}

/**
 * The pod template's containers as panels, with the actions a workload can
 * take on them: one container's logs across every pod, a shell in a pod that
 * runs it, port forwarding and an inline image change.
 */
export function WorkloadContainers({ ctx, kind, obj, pods, template }: { ctx: string; kind: WorkloadKind; obj: KubeObject; pods: KubeObject[]; template: PodTemplateSpec | undefined }) {
  const [forwardPort, setForwardPort] = useState<number>();
  const [editImageContainer, setEditImageContainer] = useState<string>();
  const push = useDetailStore((s) => s.push);
  const addTab = useDockStore((s) => s.addTab);
  const namespace = obj.metadata.namespace;
  const name = obj.metadata.name;
  const containerUsage = useContainerUsage(ctx, namespace, pods);

  // Which template containers are live somewhere, and in which pod: a shell
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
    const toPanel = (c: ContainerSpec, sidecarOrInit?: 'init' | 'sidecar'): ContainerPanelData => {
      const usage = containerUsage.get(c.name);
      return {
        name: c.name,
        image: c.image,
        kind: sidecarOrInit,
        shellable: podByContainer.has(c.name),
        ports: (c.ports ?? []).map((p) => ({ port: p.containerPort, protocol: p.protocol, name: p.name })),
        resources: containerResources(c),
        usage: usage ? { cpuMilli: usage.cpuMilli, memBytes: usage.memBytes } : undefined,
        podCount: usage?.pods,
        probes: probeRows(c, undefined, false),
        mounts: mountRows(c, template?.volumes, template?.serviceAccountName),
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
  }, [template, containerUsage, podByContainer]);

  // One container's logs across every pod of the workload; the picker still
  // lists the rest, they just start unselected. With no pods yet the tab
  // waits: it follows the workload, so pods join as they start.
  const openContainerLogs = (container: string) => {
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: `logs: ${name}/${container}`,
      ctx,
      namespace: namespace ?? '',
      pods: pods.map((pod) => pod.metadata.name),
      sources: pods.map((pod) => ({ pod: pod.metadata.name, containers: podContainerNames(pod) })),
      target: { kind, name },
      container,
      follow: true,
    });
  };

  // Any pod running the container will do: the tab title names the one you
  // landed in, and the Pods section is there to pick a specific one.
  const openContainerShell = (container: string) => {
    const pod = podByContainer.get(container);
    if (!pod) {
      showToast('error', `No running pod for container ${container}`);
      return;
    }
    addTab({ kind: 'terminal', id: dockTabId(), title: `sh: ${pod.metadata.name}/${container}`, ctx, namespace: namespace ?? '', pod: pod.metadata.name, container });
  };

  const openRef = (refKind: VolumeRefKind | EnvRefKind, refName: string) => {
    const gvk = gvkForKind(refKind);
    if (!gvk) return;
    push({ ctx, group: gvk.group, version: gvk.version, plural: gvk.plural, kind: refKind, name: refName, namespace });
  };

  return (
    <>
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
      {forwardPort !== undefined && <PortForwardDialog ctx={ctx} kind={kind} obj={obj} initialRemotePort={forwardPort} onClose={() => setForwardPort(undefined)} />}
      {editImageContainer !== undefined && (
        <SetImageDialog
          target={{ ctx, group: 'apps', version: 'v1', plural: PLURALS[kind], kind, obj }}
          initialContainer={editImageContainer}
          onClose={() => setEditImageContainer(undefined)}
          onDone={(t) => showToast('success', t)}
          onError={(e) => showToast('error', e instanceof Error ? e.message : String(e))}
        />
      )}
    </>
  );
}

/** The workload's pods with their states summed up in the header. */
export function WorkloadPods({
  ctx,
  pods,
  loading,
  emptyText,
  issues,
  showNode,
}: {
  ctx: string;
  pods: KubeObject[];
  loading: boolean;
  emptyText: string;
  issues?: Map<string, SchedulingIssue>;
  showNode?: boolean;
}) {
  return (
    <Section title="Pods" count={loading ? undefined : pods.length} flush description={loading ? undefined : podStatusSummary(pods)}>
      <PodMiniList ctx={ctx} pods={pods} loading={loading} emptyText={emptyText} issues={issues} showNode={showNode} hideNamespace />
    </Section>
  );
}
