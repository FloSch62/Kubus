import type { ResourceKindInfo } from '@kubus/shared';
import { preferVersion } from '../kind-versions.js';

export const GITOPS_GROUP_TITLE = 'GitOps';

/** The GitOps kinds worth a sidebar entry, in sidebar order: Argo CD first, then Flux. */
const GITOPS_KINDS: Array<{ group: string; plural: string }> = [
  { group: 'argoproj.io', plural: 'applications' },
  { group: 'argoproj.io', plural: 'applicationsets' },
  { group: 'argoproj.io', plural: 'appprojects' },
  { group: 'kustomize.toolkit.fluxcd.io', plural: 'kustomizations' },
  { group: 'helm.toolkit.fluxcd.io', plural: 'helmreleases' },
  { group: 'source.toolkit.fluxcd.io', plural: 'gitrepositories' },
  { group: 'source.toolkit.fluxcd.io', plural: 'ocirepositories' },
  { group: 'source.toolkit.fluxcd.io', plural: 'helmrepositories' },
  { group: 'source.toolkit.fluxcd.io', plural: 'helmcharts' },
  { group: 'source.toolkit.fluxcd.io', plural: 'buckets' },
  { group: 'notification.toolkit.fluxcd.io', plural: 'alerts' },
  { group: 'notification.toolkit.fluxcd.io', plural: 'providers' },
  { group: 'notification.toolkit.fluxcd.io', plural: 'receivers' },
  { group: 'image.toolkit.fluxcd.io', plural: 'imagerepositories' },
  { group: 'image.toolkit.fluxcd.io', plural: 'imagepolicies' },
  { group: 'image.toolkit.fluxcd.io', plural: 'imageupdateautomations' },
];

/**
 * The GitOps kinds the connected clusters serve, one version each. Empty
 * unless Argo CD (its Application kind) or Flux (any toolkit group) is
 * installed, so an Argo Rollouts-only cluster gets no GitOps group.
 */
export function gitopsNavKinds(resources: ResourceKindInfo[]): ResourceKindInfo[] {
  const listable = resources.filter((r) => r.verbs.includes('list'));
  const installed = listable.some((r) => (r.group === 'argoproj.io' && r.plural === 'applications') || r.group.endsWith('.toolkit.fluxcd.io'));
  if (!installed) return [];
  const out: ResourceKindInfo[] = [];
  for (const { group, plural } of GITOPS_KINDS) {
    let best: ResourceKindInfo | undefined;
    for (const r of listable) {
      if (r.group === group && r.plural === plural) best = best ? preferVersion(r, best) : r;
    }
    if (best) out.push(best);
  }
  return out;
}
