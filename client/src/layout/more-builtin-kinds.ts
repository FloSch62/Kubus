import { isMoreBuiltinResource, pluralLabel, type ResourceKindInfo } from '@kubus/shared';
import { preferVersion } from '../kind-versions.js';
import { naturalCompare } from '../components/natural-sort.js';

/**
 * Built-in kinds the selected clusters serve that the fixed nav groups leave
 * out (PriorityClass, Lease, IngressClass, webhook configurations, …). Built
 * from discovery, so a kind shows only where a cluster actually serves it.
 * List pages watch their kind, so only watchable kinds qualify; that also
 * keeps out read-only views such as metrics.k8s.io and componentstatuses.
 * One entry per resource, at its most stable served version.
 */
export function moreBuiltinKinds(resources: ResourceKindInfo[]): ResourceKindInfo[] {
  const byResource = new Map<string, ResourceKindInfo>();
  for (const kind of resources) {
    if (kind.custom || !kind.verbs.includes('list') || !kind.verbs.includes('watch')) continue;
    if (!isMoreBuiltinResource(kind.group, kind.plural)) continue;
    const key = `${kind.group}/${kind.plural}`;
    const current = byResource.get(key);
    byResource.set(key, current ? preferVersion(kind, current) : kind);
  }
  return [...byResource.values()].sort((a, b) => naturalCompare(pluralLabel(a.kind), pluralLabel(b.kind)) || naturalCompare(a.group, b.group));
}
