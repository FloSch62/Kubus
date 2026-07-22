import type { KubeObject, ResourceKindInfo } from '@kubus/shared';
import { expect, it } from 'vitest';
import { collectWarningEvents } from '../../../server/src/kube/overview.js';

const now = Date.parse('2026-07-21T12:00:00Z');

const resources = [
  { group: '', version: 'v1', kind: 'Node', plural: 'nodes', namespaced: false },
  { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true },
] as ResourceKindInfo[];

function warningEvent(
  namespace: string,
  involvedObject: { apiVersion: string; kind: string; name: string },
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `${involvedObject.name}.warning`, namespace },
    type: 'Warning',
    reason: 'Unhealthy',
    message: 'probe failed',
    lastTimestamp: '2026-07-21T11:59:00Z',
    involvedObject,
  } as unknown as KubeObject;
}

it('warning-event targets carry resource scope for deep links', () => {
  const events = collectWarningEvents(
    [
      warningEvent('default', { apiVersion: 'v1', kind: 'Node', name: 'worker-1' }),
      warningEvent('apps', { apiVersion: 'v1', kind: 'Pod', name: 'api-0' }),
    ],
    now,
    resources,
  );

  expect(events.map((event) => event.involvedGvr)).toEqual([
    { group: '', version: 'v1', plural: 'nodes', namespaced: false },
    { group: '', version: 'v1', plural: 'pods', namespaced: true },
  ]);
});
