import type { ResourceKindInfo } from '@kubus/shared';
import type { RawClient } from './raw-client.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface AggregatedResource {
  resource: string;
  responseKind?: { group: string; version: string; kind: string };
  scope: 'Cluster' | 'Namespaced';
  verbs: string[];
  shortNames?: string[];
  categories?: string[];
  singularResource?: string;
}

interface AggregatedVersion {
  version: string;
  resources: AggregatedResource[];
}

interface AggregatedGroup {
  metadata?: { name?: string };
  versions: AggregatedVersion[];
}

interface AggregatedDiscovery {
  items: AggregatedGroup[];
}

interface LegacyResourceList {
  groupVersion: string;
  resources: Array<{
    name: string;
    kind: string;
    namespaced: boolean;
    verbs: string[];
    shortNames?: string[];
    categories?: string[];
  }>;
}

interface LegacyGroupList {
  groups: Array<{
    name: string;
    preferredVersion?: { groupVersion: string; version: string };
    versions: Array<{ groupVersion: string; version: string }>;
  }>;
}

const BUILTIN_GROUPS = new Set([
  '',
  'apps',
  'batch',
  'autoscaling',
  'networking.k8s.io',
  'policy',
  'rbac.authorization.k8s.io',
  'storage.k8s.io',
  'apiextensions.k8s.io',
  'apiregistration.k8s.io',
  'admissionregistration.k8s.io',
  'authentication.k8s.io',
  'authorization.k8s.io',
  'certificates.k8s.io',
  'coordination.k8s.io',
  'discovery.k8s.io',
  'events.k8s.io',
  'flowcontrol.apiserver.k8s.io',
  'node.k8s.io',
  'scheduling.k8s.io',
  'metrics.k8s.io',
]);

export class DiscoveryCache {
  private cached?: { at: number; kinds: ResourceKindInfo[] };
  private inflight?: Promise<ResourceKindInfo[]>;

  constructor(private raw: RawClient) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async getResources(): Promise<ResourceKindInfo[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.kinds;
    this.inflight ??= this.discover().finally(() => {
      this.inflight = undefined;
    });
    const kinds = await this.inflight;
    this.cached = { at: Date.now(), kinds };
    return kinds;
  }

  /** Resolve a plural within a group (any version) — used for validation. */
  async find(group: string, version: string, plural: string): Promise<ResourceKindInfo | undefined> {
    const all = await this.getResources();
    return all.find((r) => r.group === group && r.version === version && r.plural === plural);
  }

  private async discover(): Promise<ResourceKindInfo[]> {
    const kinds: ResourceKindInfo[] = [];
    // Core group is never in /apis.
    const coreList = await this.raw.json<LegacyResourceList>('/api/v1');
    pushLegacy(kinds, '', 'v1', coreList);

    try {
      const agg = await this.raw.json<AggregatedDiscovery>('/apis', {
        headers: { accept: 'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json' },
      });
      if (Array.isArray(agg.items)) {
        for (const group of agg.items) {
          const groupName = group.metadata?.name ?? '';
          for (const ver of group.versions ?? []) {
            for (const res of ver.resources ?? []) {
              if (res.resource.includes('/')) continue; // skip subresources
              kinds.push({
                group: groupName,
                version: ver.version,
                kind: res.responseKind?.kind ?? res.resource,
                plural: res.resource,
                namespaced: res.scope === 'Namespaced',
                verbs: res.verbs ?? [],
                shortNames: res.shortNames,
                categories: res.categories,
                custom: !BUILTIN_GROUPS.has(groupName),
              });
            }
          }
        }
        return dedupe(kinds);
      }
    } catch {
      // fall through to legacy walk
    }

    const groupList = await this.raw.json<LegacyGroupList>('/apis');
    await Promise.all(
      (groupList.groups ?? []).map(async (g) => {
        const gv = g.preferredVersion?.groupVersion ?? g.versions[0]?.groupVersion;
        if (!gv) return;
        try {
          const list = await this.raw.json<LegacyResourceList>(`/apis/${gv}`);
          const [groupName = '', version = ''] = gv.includes('/') ? gv.split('/') : ['', gv];
          pushLegacy(kinds, groupName, version, list);
        } catch {
          // group unavailable (aggregated API down) — skip
        }
      }),
    );
    return dedupe(kinds);
  }
}

function pushLegacy(out: ResourceKindInfo[], group: string, version: string, list: LegacyResourceList): void {
  for (const res of list.resources ?? []) {
    if (res.name.includes('/')) continue;
    out.push({
      group,
      version,
      kind: res.kind,
      plural: res.name,
      namespaced: res.namespaced,
      verbs: res.verbs ?? [],
      shortNames: res.shortNames,
      categories: res.categories,
      custom: !BUILTIN_GROUPS.has(group),
    });
  }
}

function dedupe(kinds: ResourceKindInfo[]): ResourceKindInfo[] {
  const seen = new Set<string>();
  return kinds.filter((k) => {
    const key = `${k.group}/${k.version}/${k.plural}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
