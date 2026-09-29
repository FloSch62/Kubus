import type { ResourceKindInfo } from '@kubus/shared';
import { describe, expect, it } from 'vitest';
import { moreBuiltinKinds } from '../../../client/src/layout/more-builtin-kinds';
import { tabMeta } from '../../../client/src/layout/tab-meta';

const WATCH = ['get', 'list', 'watch'];

function kind(group: string, version: string, plural: string, k: string, extra: Partial<ResourceKindInfo> = {}): ResourceKindInfo {
  return { group, version, plural, kind: k, namespaced: false, verbs: WATCH, custom: false, ...extra };
}

describe('moreBuiltinKinds', () => {
  it('lists served built-in kinds that have no fixed nav entry, by plural label', () => {
    const out = moreBuiltinKinds([
      kind('scheduling.k8s.io', 'v1', 'priorityclasses', 'PriorityClass'),
      kind('coordination.k8s.io', 'v1', 'leases', 'Lease', { namespaced: true }),
      kind('node.k8s.io', 'v1', 'runtimeclasses', 'RuntimeClass'),
      kind('networking.k8s.io', 'v1', 'ingressclasses', 'IngressClass'),
      kind('', 'v1', 'pods', 'Pod', { namespaced: true }),
      kind('apps', 'v1', 'deployments', 'Deployment', { namespaced: true }),
    ]);
    expect(out.map((k) => k.kind)).toEqual(['IngressClass', 'Lease', 'PriorityClass', 'RuntimeClass']);
  });

  it('leaves out custom resources, unwatchable views and duplicates', () => {
    const out = moreBuiltinKinds([
      kind('example.com', 'v1', 'widgets', 'Widget', { custom: true }),
      kind('metrics.k8s.io', 'v1beta1', 'pods', 'PodMetrics', { verbs: ['get', 'list'] }),
      kind('', 'v1', 'componentstatuses', 'ComponentStatus', { verbs: ['get', 'list'] }),
      kind('authorization.k8s.io', 'v1', 'selfsubjectaccessreviews', 'SelfSubjectAccessReview', { verbs: ['create'] }),
      kind('events.k8s.io', 'v1', 'events', 'Event', { namespaced: true }),
      kind('storage.k8s.io', 'v1', 'csidrivers', 'CSIDriver'),
    ]);
    expect(out.map((k) => k.kind)).toEqual(['CSIDriver']);
  });

  it('keeps one entry per resource at its most stable version', () => {
    const out = moreBuiltinKinds([
      kind('admissionregistration.k8s.io', 'v1beta1', 'validatingadmissionpolicies', 'ValidatingAdmissionPolicy'),
      kind('admissionregistration.k8s.io', 'v1', 'validatingadmissionpolicies', 'ValidatingAdmissionPolicy'),
      kind('admissionregistration.k8s.io', 'v1alpha1', 'validatingadmissionpolicies', 'ValidatingAdmissionPolicy'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.version).toBe('v1');
  });

  it('is empty when the clusters serve none', () => {
    expect(moreBuiltinKinds([])).toEqual([]);
  });
});

describe('tabMeta for discovered built-in kinds', () => {
  it('uses the plural label the nav shows, and the CRD kind name for custom resources', () => {
    const discovered = [kind('coordination.k8s.io', 'v1', 'leases', 'Lease'), kind('example.com', 'v1', 'widgets', 'Widget', { custom: true })];
    expect(tabMeta('/r/coordination.k8s.io/v1/leases', discovered).title).toBe('Leases');
    expect(tabMeta('/r/example.com/v1/widgets', discovered).title).toBe('Widget');
  });
});
