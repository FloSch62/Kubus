import { describe, expect, it } from 'vitest';
import type { KubeObject, ResourceRef, SearchResult } from '@kubus/shared';
import {
  buildResultEntries,
  CUSTOM_SECTION,
  GITOPS_SECTION,
  groupStatusSummary,
  highlightParts,
  KINDS_SECTION,
  PAGES_SECTION,
  paletteStatus,
  sectionFor,
} from '../../../client/src/layout/palette-model';

function resource(kind: string, group: string, plural: string, name: string, score = 50, namespace = 'demo'): SearchResult {
  const ref: ResourceRef = { ctx: 'kind-a', group, version: 'v1', plural, kind, name, namespace };
  return { id: `resource:${name}:${kind}`, kind: 'resource', title: `${kind}/${name}`, subtitle: 'kind-a · demo', score, ref };
}

const pod = (name: string, score = 50) => resource('Pod', '', 'pods', name, score);

describe('sectionFor', () => {
  it('files built-in kinds under their sidebar group', () => {
    expect(sectionFor(pod('web-1'))).toBe('Workloads');
    expect(sectionFor(resource('Deployment', 'apps', 'deployments', 'web'))).toBe('Workloads');
    expect(sectionFor(resource('Service', '', 'services', 'web'))).toBe('Network');
    expect(sectionFor(resource('ConfigMap', '', 'configmaps', 'cfg'))).toBe('Config');
  });

  it('puts Gateway API routes under Network and Argo/Flux kinds under Helm & GitOps', () => {
    expect(sectionFor(resource('HTTPRoute', 'gateway.networking.k8s.io', 'httproutes', 'web'))).toBe('Network');
    expect(sectionFor(resource('HelmRelease', 'helm.toolkit.fluxcd.io', 'helmreleases', 'web'))).toBe(GITOPS_SECTION);
    expect(sectionFor(resource('Application', 'argoproj.io', 'applications', 'web'))).toBe(GITOPS_SECTION);
  });

  it('keeps other CRDs, kinds and pages apart', () => {
    expect(sectionFor(resource('Certificate', 'cert-manager.io', 'certificates', 'tls'))).toBe(CUSTOM_SECTION);
    expect(sectionFor({ id: 'kind:x', kind: 'kind', title: 'Pod', score: 1 })).toBe(KINDS_SECTION);
    expect(sectionFor({ id: 'page:/', kind: 'page', title: 'Overview', score: 1, path: '/' })).toBe(PAGES_SECTION);
  });
});

describe('buildResultEntries', () => {
  it('collapses three or more pods of one owner into one group row', () => {
    const results = [pod('web-5c7cd-aaaaa', 60), pod('web-5c7cd-bbbbb', 55), pod('web-5c7cd-ccccc', 50), pod('db-0', 40)];
    const entries = buildResultEntries(results, new Set());
    expect(entries.map((e) => e.type)).toEqual(['group', 'result']);
    const group = entries[0]!;
    expect(group.type === 'group' && group.base).toBe('web-5c7cd');
    expect(group.type === 'group' && group.members).toHaveLength(3);
  });

  it('leaves two siblings as separate rows', () => {
    const entries = buildResultEntries([pod('web-5c7cd-aaaaa'), pod('web-5c7cd-bbbbb')], new Set());
    expect(entries.map((e) => e.type)).toEqual(['result', 'result']);
  });

  it('lists the members after an expanded group, indented', () => {
    const results = [pod('web-5c7cd-aaaaa'), pod('web-5c7cd-bbbbb'), pod('web-5c7cd-ccccc')];
    const collapsed = buildResultEntries(results, new Set());
    const expanded = buildResultEntries(results, new Set([collapsed[0]!.id]));
    expect(expanded).toHaveLength(4);
    expect(expanded.slice(1).every((e) => e.type === 'result' && e.indent)).toBe(true);
  });

  it('orders sections by their best match, keeping the top hit first', () => {
    const results = [resource('Service', '', 'services', 'podinfo', 100), pod('podinfo-test', 40), resource('ConfigMap', '', 'configmaps', 'podinfo-cfg', 60)];
    const sections = [...new Set(buildResultEntries(results, new Set()).map((e) => e.section))];
    expect(sections).toEqual(['Network', 'Config', 'Workloads']);
  });
});

describe('highlightParts', () => {
  it('marks the whole query when it appears verbatim', () => {
    expect(highlightParts('podinfo-5c7cd', 'podinfo')).toEqual([
      { text: 'podinfo', match: true },
      { text: '-5c7cd', match: false },
    ]);
  });

  it('falls back to marking individual tokens, case-insensitively', () => {
    const parts = highlightParts('kube-apiserver-kind', 'API kind');
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['api', 'kind']);
  });

  it('returns the text unmarked without a query or a match', () => {
    expect(highlightParts('web', '')).toEqual([{ text: 'web', match: false }]);
    expect(highlightParts('web', 'zzz')).toEqual([{ text: 'web', match: false }]);
  });
});

describe('paletteStatus', () => {
  const obj = (kind: string, spec: unknown, status: unknown): KubeObject => ({ apiVersion: 'v1', kind, metadata: { name: 'x' }, spec, status }) as KubeObject;

  it('shows a pod its display status', () => {
    const crashing = obj('Pod', { containers: [{ name: 'app' }] }, {
      phase: 'Running',
      containerStatuses: [{ name: 'app', ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    });
    expect(paletteStatus('Pod', crashing)?.status).toBe('CrashLoopBackOff');
  });

  it('labels workloads with their ready count and colors by rollout state', () => {
    const ready = obj('Deployment', { replicas: 3 }, { replicas: 3, readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3 });
    expect(paletteStatus('Deployment', ready)).toEqual({ status: 'Available', label: '3/3' });
    const down = obj('Deployment', { replicas: 2 }, { replicas: 2, readyReplicas: 0, updatedReplicas: 2 });
    expect(paletteStatus('Deployment', down)).toEqual({ status: 'Unavailable', label: '0/2' });
  });

  it('falls back to status.phase and gives up without one', () => {
    expect(paletteStatus('PersistentVolumeClaim', obj('PersistentVolumeClaim', {}, { phase: 'Pending' }))?.status).toBe('Pending');
    expect(paletteStatus('Service', obj('Service', {}, {}))).toBeUndefined();
  });
});

describe('groupStatusSummary', () => {
  it('counts statuses with problems ahead of Running', () => {
    expect(groupStatusSummary(['Running', 'Running', 'CrashLoopBackOff'])).toBe('1 CrashLoopBackOff · 2 Running');
    expect(groupStatusSummary(['Running', 'Running', 'Running'])).toBe('3 Running');
  });

  it('says how many members were checked when it knows fewer than the group holds', () => {
    expect(groupStatusSummary(['Running', 'Running'], 2)).toBe('2 Running');
    expect(groupStatusSummary(['Running', 'Pending'], 20)).toBe('1 Pending · 1 Running · 2 of 20 checked');
  });
});
