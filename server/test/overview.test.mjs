import assert from 'node:assert/strict';
import test from 'node:test';
import { collectWarningEvents } from '../dist/kube/overview.js';

const now = Date.parse('2026-07-21T12:00:00Z');

const resources = [
  { group: '', version: 'v1', kind: 'Node', plural: 'nodes', namespaced: false },
  { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true },
];

function warningEvent(namespace, involvedObject) {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `${involvedObject.name}.warning`, namespace },
    type: 'Warning',
    reason: 'Unhealthy',
    message: 'probe failed',
    lastTimestamp: '2026-07-21T11:59:00Z',
    involvedObject,
  };
}

void test('warning-event targets carry resource scope for deep links', () => {
  const events = collectWarningEvents(
    [
      warningEvent('default', { apiVersion: 'v1', kind: 'Node', name: 'worker-1' }),
      warningEvent('apps', { apiVersion: 'v1', kind: 'Pod', name: 'api-0' }),
    ],
    now,
    resources,
  );

  assert.deepEqual(events.map((event) => event.involvedGvr), [
    { group: '', version: 'v1', plural: 'nodes', namespaced: false },
    { group: '', version: 'v1', plural: 'pods', namespaced: true },
  ]);
});
