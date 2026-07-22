import type { KubeObject } from '@kubus/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { resolvePodEnv } from '../../../server/src/kube/pod-env';

function handleFor(revealSecret = 'c2VjcmV0') {
  const pod: KubeObject = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'web-0',
      namespace: 'apps',
      uid: 'pod-uid',
      labels: { app: 'web' },
      annotations: { owner: 'team-a' },
    },
    spec: {
      nodeName: 'worker-1',
      serviceAccountName: 'web-sa',
      initContainers: [
        {
          name: 'init',
          resources: { requests: { cpu: '250m' } },
          env: [
            { name: 'INIT_LITERAL', value: '' },
            { name: 'MAIN_CPU', valueFrom: { resourceFieldRef: { containerName: 'app', resource: 'limits.cpu', divisor: '1m' } } },
          ],
        },
      ],
      containers: [
        {
          name: 'app',
          resources: { limits: { cpu: '500m', memory: '128Mi' }, requests: { cpu: '125m' } },
          envFrom: [
            { prefix: 'CFG_', configMapRef: { name: 'settings' } },
            { secretRef: { name: 'credentials' } },
            { configMapRef: { name: 'missing' } },
            { configMapRef: { name: 'optional-missing', optional: true } },
            {},
          ],
          env: [
            { name: 'LITERAL', value: 'literal' },
            { name: 'CONFIG_KEY', valueFrom: { configMapKeyRef: { name: 'settings', key: 'MODE' } } },
            { name: 'CONFIG_MISSING', valueFrom: { configMapKeyRef: { name: 'settings', key: 'MISSING' } } },
            { name: 'CONFIG_OPTIONAL', valueFrom: { configMapKeyRef: { name: 'settings', key: 'MISSING', optional: true } } },
            { name: 'SECRET_KEY', valueFrom: { secretKeyRef: { name: 'credentials', key: 'PASSWORD' } } },
            { name: 'SECRET_MISSING', valueFrom: { secretKeyRef: { name: 'credentials', key: 'MISSING' } } },
            { name: 'SECRET_OPTIONAL', valueFrom: { secretKeyRef: { name: 'credentials', key: 'MISSING', optional: true } } },
            { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
            { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
            { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
            { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
            { name: 'SERVICE_ACCOUNT', valueFrom: { fieldRef: { fieldPath: 'spec.serviceAccountName' } } },
            { name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
            { name: 'HOST_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
            { name: 'POD_IPS', valueFrom: { fieldRef: { fieldPath: 'status.podIPs' } } },
            { name: 'LABEL', valueFrom: { fieldRef: { fieldPath: "metadata.labels['app']" } } },
            { name: 'ANNOTATION', valueFrom: { fieldRef: { fieldPath: "metadata.annotations['owner']" } } },
            { name: 'UNKNOWN_FIELD', valueFrom: { fieldRef: { fieldPath: 'spec.unknown' } } },
            { name: 'CPU_MILLI', valueFrom: { resourceFieldRef: { resource: 'limits.cpu', divisor: '1m' } } },
            { name: 'MEM_MIB', valueFrom: { resourceFieldRef: { resource: 'limits.memory', divisor: '1Mi' } } },
            { name: 'MISSING_RESOURCE', valueFrom: { resourceFieldRef: { resource: 'requests.memory' } } },
            { name: 'UNKNOWN_SOURCE', valueFrom: {} },
          ],
        },
      ],
    },
    status: { podIP: '10.0.0.10', hostIP: '192.168.1.10', podIPs: [{ ip: '10.0.0.10' }, { ip: 'fd00::10' }] },
  } as KubeObject;
  const raw = vi.fn(async (path: string) => {
    if (path.endsWith('/pods/web-0')) return pod;
    if (path.endsWith('/configmaps/settings')) return { data: { MODE: 'production', COLOR: 'blue' } };
    if (path.endsWith('/secrets/credentials')) return { data: { PASSWORD: revealSecret, TOKEN: 'dG9rZW4=' } };
    throw new Error('not found');
  });
  return { handle: { raw: { json: raw } } as unknown as ClusterHandle, raw };
}

function byName(entries: Array<{ name: string }>, name: string) {
  return entries.find((entry) => entry.name === name);
}

describe('resolvePodEnv', () => {
  it('expands every Kubernetes environment source while preserving order and hiding secrets', async () => {
    const { handle, raw } = handleFor();
    const result = await resolvePodEnv(handle, 'apps', 'web-0', false);
    expect(result.containers.map((container) => [container.name, container.init])).toEqual([
      ['init', true],
      ['app', undefined],
    ]);
    const init = result.containers[0]!.env;
    expect(init).toEqual([
      { name: 'INIT_LITERAL', value: '', source: { type: 'literal' } },
      { name: 'MAIN_CPU', value: '500', source: { type: 'resourceFieldRef', key: 'limits.cpu' } },
    ]);

    const env = result.containers[1]!.env;
    expect(env.slice(0, 5)).toEqual([
      { name: 'CFG_MODE', value: 'production', source: { type: 'configMapRef', ref: 'settings', key: 'MODE' } },
      { name: 'CFG_COLOR', value: 'blue', source: { type: 'configMapRef', ref: 'settings', key: 'COLOR' } },
      { name: 'PASSWORD', value: '••••••••', source: { type: 'secretRef', ref: 'credentials', key: 'PASSWORD' }, redacted: true },
      { name: 'TOKEN', value: '••••••••', source: { type: 'secretRef', ref: 'credentials', key: 'TOKEN' }, redacted: true },
      { name: '*', source: { type: 'configMapRef', ref: 'missing' }, error: 'configmap missing not found' },
    ]);
    expect(byName(env, 'CONFIG_KEY')).toEqual({
      name: 'CONFIG_KEY',
      value: 'production',
      source: { type: 'configMapKeyRef', ref: 'settings', key: 'MODE' },
    });
    expect(byName(env, 'CONFIG_MISSING')).toEqual(
      expect.objectContaining({ error: 'configmap key settings/MISSING not found' }),
    );
    expect(byName(env, 'CONFIG_OPTIONAL')).toBeUndefined();
    expect(byName(env, 'SECRET_KEY')).toEqual(
      expect.objectContaining({ value: '••••••••', redacted: true, source: { type: 'secretKeyRef', ref: 'credentials', key: 'PASSWORD' } }),
    );
    expect(byName(env, 'SECRET_MISSING')).toEqual(expect.objectContaining({ error: 'secret key credentials/MISSING not found' }));
    expect(byName(env, 'SECRET_OPTIONAL')).toBeUndefined();
    expect(byName(env, 'POD_NAME')).toEqual(expect.objectContaining({ value: 'web-0' }));
    expect(byName(env, 'POD_NAMESPACE')).toEqual(expect.objectContaining({ value: 'apps' }));
    expect(byName(env, 'POD_UID')).toEqual(expect.objectContaining({ value: 'pod-uid' }));
    expect(byName(env, 'NODE_NAME')).toEqual(expect.objectContaining({ value: 'worker-1' }));
    expect(byName(env, 'SERVICE_ACCOUNT')).toEqual(expect.objectContaining({ value: 'web-sa' }));
    expect(byName(env, 'POD_IP')).toEqual(expect.objectContaining({ value: '10.0.0.10' }));
    expect(byName(env, 'HOST_IP')).toEqual(expect.objectContaining({ value: '192.168.1.10' }));
    expect(byName(env, 'POD_IPS')).toEqual(expect.objectContaining({ value: '10.0.0.10,fd00::10' }));
    expect(byName(env, 'LABEL')).toEqual(expect.objectContaining({ value: 'web' }));
    expect(byName(env, 'ANNOTATION')).toEqual(expect.objectContaining({ value: 'team-a' }));
    expect(byName(env, 'UNKNOWN_FIELD')).toEqual(expect.objectContaining({ error: 'unresolvable fieldPath' }));
    expect(byName(env, 'CPU_MILLI')).toEqual(expect.objectContaining({ value: '500' }));
    expect(byName(env, 'MEM_MIB')).toEqual(expect.objectContaining({ value: '128' }));
    expect(byName(env, 'MISSING_RESOURCE')).toEqual(
      expect.objectContaining({ error: expect.stringContaining('requests.memory not set') }),
    );
    expect(byName(env, 'UNKNOWN_SOURCE')).toEqual({ name: 'UNKNOWN_SOURCE', error: 'unknown valueFrom source' });

    expect(raw.mock.calls.filter(([path]) => String(path).endsWith('/configmaps/settings'))).toHaveLength(1);
    expect(raw.mock.calls.filter(([path]) => String(path).endsWith('/secrets/credentials'))).toHaveLength(1);
    expect(raw.mock.calls.filter(([path]) => String(path).includes('optional-missing'))).toHaveLength(1);
  });

  it('reveals decoded secret values only when explicitly requested', async () => {
    const { handle } = handleFor();
    const result = await resolvePodEnv(handle, 'apps', 'web-0', true);
    const env = result.containers[1]!.env;
    expect(byName(env, 'PASSWORD')).toEqual(expect.objectContaining({ value: 'secret', redacted: true }));
    expect(byName(env, 'SECRET_KEY')).toEqual(expect.objectContaining({ value: 'secret', redacted: true }));
  });

  it('returns no containers for pods without a spec', async () => {
    const raw = vi.fn(async () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'empty', namespace: 'apps' } }));
    expect(await resolvePodEnv({ raw: { json: raw } } as unknown as ClusterHandle, 'apps', 'empty', false)).toEqual({ containers: [] });
  });
});
