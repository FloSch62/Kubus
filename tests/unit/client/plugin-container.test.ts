import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { resolvePluginContainer } from '../../../client/src/plugins/pod-container.js';
const pod: KubeObject = {
  metadata: { name: 'device', uid: 'pod-uid', annotations: { 'kubectl.kubernetes.io/default-container': 'nos' } },
  spec: {
    containers: [{ name: 'other' }, { name: 'nos' }],
    initContainers: [{ name: 'planner' }, { name: 'clabwire', restartPolicy: 'Always' }],
  },
};
describe('plugin Pod action boundary', () => {
  it('honors the Pod default device, falling back only to an application container', () => {
    expect(resolvePluginContainer(pod, 'pod.terminal')).toBe('nos');
    expect(
      resolvePluginContainer(
        { ...pod, metadata: { ...pod.metadata, annotations: { 'kubectl.kubernetes.io/default-container': 'missing' } } },
        'pod.logs',
      ),
    ).toBe('other');
  });
  it('permits preparation and native sidecar logs but rejects their shell requests', () => {
    for (const name of ['planner', 'clabwire']) {
      expect(resolvePluginContainer(pod, 'pod.logs', name)).toBe(name);
      expect(() => resolvePluginContainer(pod, 'pod.terminal', name)).toThrow('not available');
    }
  });
  it('rejects stale or invented container names before opening a dock tab', () => {
    expect(() => resolvePluginContainer(pod, 'pod.logs', 'deleted')).toThrow();
    expect(() => resolvePluginContainer({ metadata: pod.metadata }, 'pod.terminal')).toThrow();
  });
});
