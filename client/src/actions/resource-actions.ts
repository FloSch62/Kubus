import { useCallback } from 'react';
import { gvkForResource, type KubeObject, type ResourceRef } from '@kubus/shared';
import {
  resolveLogTargetPods,
  useCordon,
  useRerunJob,
  useRolloutRestart,
  useSuspendCronJob,
  useTriggerCronJob,
} from '../api/queries.js';
import { apiFetch } from '../api/http.js';
import { resourceUrl } from '../api/queries.js';
import { useDockStore, dockTabId } from '../state/dock.js';
import { podContainerNames } from '../kube-display.js';

/**
 * Palette actions for a resource. `run` actions execute immediately and
 * resolve to a toast message; `detail` actions deep-link to the resource's
 * detail drawer, where the full dialog flow (incl. protected-cluster
 * type-to-confirm) lives — the palette never runs destructive actions
 * directly.
 */
export interface PaletteAction {
  id: string;
  title: string;
  kind: 'run' | 'detail';
  danger?: boolean;
}

const LOGS: PaletteAction = { id: 'logs', title: 'Logs', kind: 'run' };
const SHELL: PaletteAction = { id: 'shell', title: 'Shell', kind: 'run' };
const RESTART: PaletteAction = { id: 'restart', title: 'Rollout restart', kind: 'run' };
const TRIGGER: PaletteAction = { id: 'trigger', title: 'Trigger now', kind: 'run' };
const RERUN: PaletteAction = { id: 'rerun', title: 'Re-run', kind: 'run' };
const SUSPEND: PaletteAction = { id: 'suspend-toggle', title: 'Suspend / Resume', kind: 'run' };
const CORDON: PaletteAction = { id: 'cordon-toggle', title: 'Cordon / Uncordon', kind: 'run' };
const OPEN: PaletteAction = { id: 'open', title: 'Open details', kind: 'detail' };
const MORE: PaletteAction = { id: 'open-more', title: 'More actions… (delete, scale, forward)', kind: 'detail' };

export function actionsForRef(ref: ResourceRef): PaletteAction[] {
  const kind = gvkForResource(ref.group, ref.version, ref.plural)?.kind === ref.kind ? ref.kind : undefined;
  switch (kind) {
    case 'Pod':
      return [OPEN, LOGS, SHELL, MORE];
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
      return [OPEN, LOGS, RESTART, MORE];
    case 'ReplicaSet':
      return [OPEN, LOGS, MORE];
    case 'Service':
      return [OPEN, LOGS, MORE];
    case 'CronJob':
      return [OPEN, TRIGGER, SUSPEND, MORE];
    case 'Job':
      return [OPEN, RERUN, MORE];
    case 'Node':
      return [OPEN, CORDON, MORE];
    default:
      return [OPEN, MORE];
  }
}

/** Execute a `run` palette action; resolves to a toast message. */
export function usePaletteRunner(): (action: PaletteAction, ref: ResourceRef) => Promise<string> {
  const restart = useRolloutRestart();
  const trigger = useTriggerCronJob();
  const rerun = useRerunJob();
  const suspendCj = useSuspendCronJob();
  const cordon = useCordon();
  const addTab = useDockStore((s) => s.addTab);

  return useCallback(
    async (action, ref) => {
      const namespace = ref.namespace ?? '';
      const fetchObj = () => apiFetch<KubeObject>(resourceUrl(ref.ctx, ref.group, ref.version, ref.plural, ref.name, ref.namespace));
      switch (action.id) {
        case 'logs': {
          const { pods } = await resolveLogTargetPods({ ctx: ref.ctx, group: ref.group, version: ref.version, plural: ref.plural, kind: ref.kind as 'Pod', namespace, name: ref.name });
          if (!pods.length) throw new Error(`No pods found for ${ref.kind} ${namespace}/${ref.name}`);
          const byNamespace = new Map<string, string[]>();
          for (const pod of pods) {
            const names = byNamespace.get(pod.namespace);
            if (names) names.push(pod.name);
            else byNamespace.set(pod.namespace, [pod.name]);
          }
          for (const [ns, podNames] of byNamespace) {
            addTab({
              kind: 'logs',
              id: dockTabId(),
              title: pods.length === 1 ? `logs: ${podNames[0] ?? ref.name}` : `logs: ${ref.kind}/${ref.name}`,
              ctx: ref.ctx,
              namespace: ns,
              pods: podNames,
              follow: true,
            });
          }
          return `Streaming logs for ${ref.kind}/${ref.name}`;
        }
        case 'shell': {
          const obj = await fetchObj();
          const container = podContainerNames(obj)[0] ?? '';
          addTab({ kind: 'terminal', id: dockTabId(), title: `sh: ${ref.name}`, ctx: ref.ctx, namespace, pod: ref.name, container });
          return `Shell opened for ${ref.name}`;
        }
        case 'restart':
          await restart.mutateAsync({ ctx: ref.ctx, body: { kind: ref.kind as 'Deployment', namespace, name: ref.name } });
          return `Rollout restart triggered for ${ref.name}`;
        case 'trigger': {
          const r = await trigger.mutateAsync({ ctx: ref.ctx, body: { namespace, name: ref.name } });
          return `Created job ${r.jobName}`;
        }
        case 'rerun': {
          const r = await rerun.mutateAsync({ ctx: ref.ctx, body: { namespace, name: ref.name } });
          return `Created job ${r.jobName}`;
        }
        case 'suspend-toggle': {
          const obj = await fetchObj();
          const suspended = !!(obj.spec as { suspend?: boolean })?.suspend;
          await suspendCj.mutateAsync({ ctx: ref.ctx, body: { namespace, name: ref.name, suspend: !suspended } });
          return `${suspended ? 'Resumed' : 'Suspended'} ${ref.name}`;
        }
        case 'cordon-toggle': {
          const obj = await fetchObj();
          const unschedulable = !!(obj.spec as { unschedulable?: boolean })?.unschedulable;
          await cordon.mutateAsync({ ctx: ref.ctx, body: { node: ref.name, unschedulable: !unschedulable } });
          return `${unschedulable ? 'Uncordoned' : 'Cordoned'} ${ref.name}`;
        }
        default:
          throw new Error(`unknown palette action ${action.id}`);
      }
    },
    [restart, trigger, rerun, suspendCj, cordon, addTab],
  );
}
