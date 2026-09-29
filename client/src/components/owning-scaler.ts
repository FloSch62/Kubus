import type { KubeObject } from '@kubus/shared';

interface HpaSpec {
  scaleTargetRef?: { apiVersion?: string; kind?: string; name?: string };
  minReplicas?: number;
  maxReplicas?: number;
}

export interface OwningScaler {
  /** The resource the user should edit: the ScaledObject when the HPA is KEDA-managed, else the HPA itself. */
  kind: 'ScaledObject' | 'HorizontalPodAutoscaler';
  name: string;
  gvr: { group: string; version: string; plural: string };
  minReplicas?: number;
  maxReplicas?: number;
}

/** A scalable workload: its kind and API group plus the object itself. */
export interface ScaleTargetRef {
  kind: string;
  group: string;
  obj: KubeObject;
}

/**
 * The HPA (or the KEDA ScaledObject behind it) among `hpas` whose scale
 * target is this workload. `hpas` must come from the workload's namespace.
 */
export function findOwningScaler(target: ScaleTargetRef, hpas: KubeObject[] | undefined): OwningScaler | undefined {
  const hpa = hpas?.find((h) => {
    const ref = (h.spec as HpaSpec | undefined)?.scaleTargetRef;
    if (ref?.kind !== target.kind || ref.name !== target.obj.metadata.name) return false;
    const refGroup = ref.apiVersion ? (ref.apiVersion.includes('/') ? ref.apiVersion.split('/')[0] : '') : undefined;
    return refGroup === undefined || refGroup === target.group;
  });
  if (!hpa) return undefined;
  const spec = hpa.spec as HpaSpec | undefined;
  const scaledObject =
    (hpa.metadata.ownerReferences ?? []).find((o) => o.kind === 'ScaledObject')?.name ?? hpa.metadata.labels?.['scaledobject.keda.sh/name'];
  return scaledObject
    ? { kind: 'ScaledObject', name: scaledObject, gvr: { group: 'keda.sh', version: 'v1alpha1', plural: 'scaledobjects' }, minReplicas: spec?.minReplicas, maxReplicas: spec?.maxReplicas }
    : {
        kind: 'HorizontalPodAutoscaler',
        name: hpa.metadata.name,
        gvr: { group: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers' },
        minReplicas: spec?.minReplicas,
        maxReplicas: spec?.maxReplicas,
      };
}
