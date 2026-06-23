import { Divider } from '@mui/material';
import type { KubeObject } from '@kubus/shared';
import { useMemo } from 'react';
import { useResourceList } from '../../api/queries.js';
import { GenericDetail } from './GenericDetail.js';
import { PodMiniList } from './PodMiniList.js';

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }>;
}

interface DeploymentSpec {
  selector?: LabelSelector;
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

export function DeploymentDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const namespace = obj.metadata.namespace;
  const labelSelector = selectorToString((obj.spec as DeploymentSpec | undefined)?.selector);
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

  return (
    <GenericDetail obj={obj} ctx={ctx}>
      <Divider />
      <PodMiniList
        ctx={ctx}
        pods={pods}
        title="Pods"
        loading={replicaSetsQuery.isLoading || podsQuery.isLoading}
        emptyText={labelSelector ? 'No pods owned by this Deployment.' : 'No selector on this Deployment.'}
      />
    </GenericDetail>
  );
}
