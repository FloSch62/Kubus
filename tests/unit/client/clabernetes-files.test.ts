import { describe, expect, it } from 'vitest';
import { configRelations, fileDestination } from '../../../plugins/clabernetes/src/configmaps.js';
import { endpointState, observedLinkState } from '../../../plugins/clabernetes/src/interfaces.js';
import { key, type Located } from '../../../plugins/clabernetes/src/model.js';
const node: Located = {
  ctx: 'a',
  group: 'c9s.run',
  plural: 'nodes',
  metadata: { name: 'leaf1', namespace: 'lab', uid: 'node' },
  spec: {
    'startup-config': 'configs/leaf1.cfg',
    filesFromConfigMap: [{ configMapName: 'startup', configMapPath: 'config', filePath: 'configs/leaf1.cfg' }],
  },
};
const map = (name: string): Located => ({
  ctx: 'a',
  group: '',
  plural: 'configmaps',
  metadata: { name, namespace: 'lab' },
  data: { config: 'example' },
});
const pod: Located = {
  ctx: 'a',
  group: '',
  plural: 'pods',
  metadata: { name: 'device', namespace: 'lab', labels: { 'c9s.run/direct-workload': 'leaf1' } },
  spec: {
    containers: [{ name: 'device', volumeMounts: [{ name: 'plan', mountPath: '/plan' }] }],
    volumes: [
      { name: 'startup', configMap: { name: 'startup' } },
      { name: 'plan', configMap: { name: 'active-plan', items: [{ key: 'plan.json', path: 'plan.json' }] } },
    ],
  },
};
describe('device ConfigMap relationships', () => {
  it('resolves exact and directory containerlab binds to device destinations', () => {
    const bound = { ...node, spec: { binds: ['configs/client:/config', './configs/gnmic.yml:/gnmic-config.yml:ro'] } };
    expect(fileDestination(bound, 'configs/client/iperf.sh')).toBe('/config/iperf.sh');
    expect(fileDestination(bound, 'configs/gnmic.yml')).toBe('/gnmic-config.yml');
    expect(fileDestination(bound, 'configs/client-other/x')).toBe('configs/client-other/x');
  });
  it('traces the startup key and file path, active mounted plan and old unmounted artifacts separately', () => {
    const active = { ...map('active-plan'), metadata: { ...map('active-plan').metadata, labels: { 'c9s.run/component': 'node-plan' } } };
    const previous = {
      ...map('old-plan'),
      metadata: { ...map('old-plan').metadata, labels: { 'c9s.run/component': 'node-plan', 'c9s.run/planOwnerUID': 'node' } },
    };
    const rows = configRelations([node], [pod], [map('startup'), active, previous, map('unrelated')]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      purpose: 'Startup configuration',
      dataKey: 'config',
      path: 'configs/leaf1.cfg',
      state: 'Available',
      pod,
    });
    expect(rows[1]).toMatchObject({ name: 'active-plan', purpose: 'Device plan', state: 'Mounted', path: '/plan' });
    expect(rows[2]).toMatchObject({ name: 'old-plan', state: 'Not mounted' });
  });
  it('does not cross cluster/namespace boundaries and distinguishes missing keys from inaccessible maps', () => {
    expect(configRelations([node], [], [{ ...map('startup'), ctx: 'b' }])[0]?.state).toBe('Map unavailable');
    expect(configRelations([node], [], [{ ...map('startup'), data: {} }])[0]?.state).toBe('Key missing');
    expect(configRelations([node], [], [{ ...map('startup'), data: {}, binaryData: { config: 'YQ==' } }])[0]?.state).toBe('Available');
  });
});
describe('observed endpoint state', () => {
  const link: Located = { ...node, plural: 'links', spec: { endpointA: { nodeName: 'leaf1', interfaceName: 'e1-1' } } };
  it('reports real carrier independently of controller readiness and handles missing/replaced endpoints', () => {
    const observations = {
      [key(node)]: {
        snapshot: {
          podUID: 'pod',
          container: 'device',
          observedAt: '2026-09-19T12:00:00Z',
          interfaces: [{ name: 'e1-1', adminUp: true, carrier: false, operState: 'DOWN' }],
        },
      },
    };
    expect(endpointState(link, 'A', [node], observations).label).toBe('Down');
    expect(observedLinkState('Up', 'Down')).toBe('Down');
    expect(observedLinkState('Up', 'Unknown')).toBe('Unknown');
    expect(
      endpointState({ ...link, status: { resolvedEndpoints: { endpointA: { uid: 'old-node' } } } }, 'A', [node], observations).label,
    ).toBe('Stale');
    expect(
      endpointState({ ...link, spec: { endpointA: { nodeName: 'leaf1', interfaceName: 'e1-99' } } }, 'A', [node], observations).label,
    ).toBe('Missing');
  });
});
