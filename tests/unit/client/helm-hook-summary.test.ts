import { describe, expect, it } from 'vitest';
import type { HelmReleaseResource } from '@kubus/shared';
import { helmHookSummary, helmResourceSummary } from '../../../client/src/components/HelmReleaseResources';

const hook = (name: string, events: string[], state: HelmReleaseResource['state'] = 'missing'): HelmReleaseResource => ({
  kind: 'Pod',
  apiVersion: 'v1',
  group: '',
  version: 'v1',
  plural: 'pods',
  namespaced: true,
  namespace: 'demo',
  name,
  state,
  hookEvents: events,
});

describe('helm hook rows', () => {
  it('folds test hooks into one line that says they appear only when tests run', () => {
    const hooks = [hook('podinfo-grpc-test', ['test']), hook('podinfo-jwt-test', ['test']), hook('podinfo-service-test', ['test'])];
    expect(helmHookSummary(hooks)).toBe('3 test hooks (podinfo-grpc-test, podinfo-jwt-test, podinfo-service-test) · not present until helm test runs');
    // Hooks never count as missing manifest objects.
    expect(helmResourceSummary(hooks)).toMatchObject({ total: 0, failed: 0, hooks: 3 });
  });

  it('names other hooks, caps the list and counts present ones', () => {
    const hooks = [hook('a', ['pre-install'], 'present'), hook('b', ['post-install']), hook('c', ['pre-delete']), hook('d', ['test'])];
    expect(helmHookSummary(hooks)).toBe('4 hooks (a, b, c +1) · 1 present');
    expect(helmHookSummary([hook('m', ['pre-upgrade'])])).toBe('1 hook (m) · not present right now (hooks run during install, upgrade or delete)');
  });
});
