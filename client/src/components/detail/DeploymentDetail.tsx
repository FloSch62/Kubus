import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import type { ContainerUsage, KubeObject } from '@kubus/shared';
import { useMemo, useState } from 'react';
import { PortForwardDialog } from '../PortForwardDialog.js';
import { SetImageDialog } from '../RowActions.js';
import { useResourceList, useResourceMetrics } from '../../api/queries.js';
import { containerResources, workloadReady } from '../../kube-display.js';
import { showToast } from '../../state/toast.js';
import { ReadyCounter } from '../ReadyCounter.js';
import { ConditionChips, ConditionRows, KeyValueSection, MetadataSection, hasUnhealthyCondition } from './GenericDetail.js';
import { ContainerCards, type ContainerCardData } from './ContainerCards.js';
import { PodMiniList } from './PodMiniList.js';
import { Section } from './Section.js';

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }>;
}

interface TemplateContainer {
  name: string;
  image?: string;
  restartPolicy?: string;
  ports?: Array<{ containerPort: number; protocol?: string; name?: string }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}

interface DeploymentSpec {
  selector?: LabelSelector;
  paused?: boolean;
  strategy?: { type?: string; rollingUpdate?: { maxUnavailable?: number | string; maxSurge?: number | string } };
  template?: { spec?: { containers?: TemplateContainer[]; initContainers?: TemplateContainer[] } };
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

// ReplicaFailure=True is the only bad-when-true Deployment condition.
const deploymentGoodWhen = (type: string): 'True' | 'False' => (type === 'ReplicaFailure' ? 'False' : 'True');

export function DeploymentDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const [forwardPort, setForwardPort] = useState<number>();
  const [editImageContainer, setEditImageContainer] = useState<string>();
  const namespace = obj.metadata.namespace;
  const spec = obj.spec as DeploymentSpec | undefined;
  const labelSelector = selectorToString(spec?.selector);
  const enabled = !!namespace && !!labelSelector;
  const replicaSetsQuery = useResourceList(
    enabled ? { ctx, group: 'apps', version: 'v1', plural: 'replicasets', namespace, labelSelector } : undefined,
  );
  const podsQuery = useResourceList(enabled ? { ctx, group: '', version: 'v1', plural: 'pods', namespace, labelSelector } : undefined);

  const pods = useMemo(() => {
    const replicaSetUids = new Set((replicaSetsQuery.data?.items ?? []).filter((rs) => ownedBy(rs, obj.metadata.uid)).map((rs) => rs.metadata.uid));
    return (podsQuery.data?.items ?? [])
      .filter((pod) => (pod.metadata.ownerReferences ?? []).some((owner) => replicaSetUids.has(owner.uid) && owner.controller))
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }, [obj.metadata.uid, podsQuery.data?.items, replicaSetsQuery.data?.items]);

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

  const cards = useMemo(() => {
    const toCard = (c: TemplateContainer, kind?: 'init' | 'sidecar'): ContainerCardData => {
      const usage = containerUsage.get(c.name);
      return {
        name: c.name,
        image: c.image,
        kind,
        ports: (c.ports ?? []).map((p) => ({ port: p.containerPort, protocol: p.protocol, name: p.name })),
        resources: containerResources(c),
        usage: usage ? { cpuMilli: usage.cpuMilli, memBytes: usage.memBytes } : undefined,
        podCount: usage?.pods,
      };
    };
    return [
      ...(spec?.template?.spec?.containers ?? []).map((c) => toCard(c)),
      ...(spec?.template?.spec?.initContainers ?? []).map((c) => toCard(c, c.restartPolicy === 'Always' ? 'sidecar' : 'init')),
    ];
  }, [spec, containerUsage]);

  const strategy = spec?.strategy?.type;
  const rolling = spec?.strategy?.rollingUpdate;
  const hasConditions = ((obj.status as { conditions?: unknown[] } | undefined)?.conditions?.length ?? 0) > 0;

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, alignItems: 'center' }}>
        <Chip label={<>Ready <ReadyCounter value={workloadReady(obj)} /></>} variant="outlined" />
        {strategy && (
          <Tooltip title={rolling ? `maxUnavailable ${rolling.maxUnavailable ?? '-'} · maxSurge ${rolling.maxSurge ?? '-'}` : ''}>
            <Chip label={`Strategy ${strategy}`} variant="outlined" />
          </Tooltip>
        )}
        {spec?.paused && <Chip label="Paused" color="warning" size="small" />}
        <ConditionChips obj={obj} goodWhen={deploymentGoodWhen} />
      </Stack>
      <Section title="Containers" count={cards.length}>
        <ContainerCards items={cards} onForwardPort={setForwardPort} onEditImage={setEditImageContainer} />
      </Section>
      <Section title="Pods" count={pods.length}>
        <PodMiniList
          ctx={ctx}
          pods={pods}
          loading={replicaSetsQuery.isLoading || podsQuery.isLoading}
          emptyText={labelSelector ? 'No pods owned by this Deployment.' : 'No selector on this Deployment.'}
          hideNamespace
        />
      </Section>
      {hasConditions && (
        <Section title="Conditions" defaultOpen={hasUnhealthyCondition(obj, deploymentGoodWhen)}>
          <ConditionRows
            conditions={(obj.status as { conditions: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }> }).conditions}
            goodWhen={deploymentGoodWhen}
          />
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
    </Stack>
  );
}
