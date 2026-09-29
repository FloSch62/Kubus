import { useCallback } from 'react';
import { gvkForKind, gvkForResource, type ResourceKindInfo } from '@kubus/shared';
import { DETAIL_LIST_LIVE_MS, useApiResources, useResourceList } from '../../../api/queries.js';
import { preferVersion } from '../../../kind-versions.js';
import { useDetailStore } from '../../../state/detail.js';

export interface ObjectRef {
  /** API group; `''` is core. Undefined means "whatever group serves this kind", builtins first. */
  group?: string;
  kind: string;
  name: string;
  namespace?: string;
}

export interface ResolvedKind {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

/** The served GVR for a kind: discovery's preferred version, or the builtin table before discovery loads. */
export function resolveKind(resources: ResourceKindInfo[] | undefined, group: string | undefined, kind: string): ResolvedKind | undefined {
  const builtin = gvkForKind(kind);
  if (builtin && (group === undefined || builtin.group === group)) return builtin;
  let best: ResourceKindInfo | undefined;
  for (const info of resources ?? []) {
    if (info.kind !== kind || (group !== undefined && info.group !== group)) continue;
    best = best ? preferVersion(info, best) : info;
  }
  return best;
}

/**
 * Opener for objects a custom resource names (a route's backend Service, a
 * Kustomization's source, an Application's managed Deployment): pushes the
 * object onto the drawer stack, or gives undefined when the kind is not
 * served by the cluster, so the caller renders plain text instead of a link.
 */
export function useObjectOpener(ctx: string): (ref: ObjectRef) => (() => void) | undefined {
  const push = useDetailStore((s) => s.push);
  const { data: resources } = useApiResources(ctx);
  return useCallback(
    (ref: ObjectRef) => {
      const gvr = resolveKind(resources, ref.group, ref.kind);
      if (!gvr || !ref.name) return undefined;
      return () =>
        push({
          ctx,
          group: gvr.group,
          version: gvr.version,
          plural: gvr.plural,
          kind: gvr.kind,
          name: ref.name,
          namespace: gvr.namespaced ? ref.namespace : undefined,
          custom: !gvkForResource(gvr.group, gvr.version, gvr.plural),
        });
    },
    [ctx, push, resources],
  );
}

/**
 * Every object of a kind named by group and kind (cluster-wide, or in one
 * namespace), at the version the cluster serves. Empty until discovery
 * resolves the kind; a kind the cluster does not serve stays empty.
 */
export function useKindList(ctx: string, group: string, kind: string, opts?: { namespace?: string; enabled?: boolean }) {
  const { data: resources } = useApiResources(ctx);
  const gvr = opts?.enabled === false ? undefined : resolveKind(resources, group, kind);
  return useResourceList(gvr ? { ctx, group: gvr.group, version: gvr.version, plural: gvr.plural, namespace: opts?.namespace } : undefined, { liveMs: DETAIL_LIST_LIVE_MS });
}
