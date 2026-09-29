import { describe, expect, it } from 'vitest';
import {
  containerState,
  mountRows,
  probePort,
  probeRows,
  templateEnv,
  volumeInfo,
  volumeLabel,
  type ContainerSpec,
  type ContainerStatus,
} from '../../../client/src/components/detail/container-spec';

const container: ContainerSpec = {
  name: 'app',
  readinessProbe: { httpGet: { path: '/ready', port: 8080 }, periodSeconds: 5 },
  livenessProbe: { tcpSocket: { port: 'http' }, failureThreshold: 6 },
  startupProbe: { grpc: { port: 9090 } },
  volumeMounts: [
    { name: 'config', mountPath: '/etc/app', readOnly: true, subPath: 'app.yaml' },
    { name: 'cache', mountPath: '/cache' },
    { name: 'missing', mountPath: '/nowhere' },
  ],
  env: [
    { name: 'LITERAL', value: 'yes' },
    { name: 'EMPTY' },
    { name: 'FROM_CM', valueFrom: { configMapKeyRef: { name: 'cm', key: 'k' } } },
    { name: 'FROM_SECRET', valueFrom: { secretKeyRef: { name: 'sec', key: 'pw' } } },
    { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    { name: 'CPU', valueFrom: { resourceFieldRef: { resource: 'limits.cpu' } } },
  ],
  envFrom: [{ configMapRef: { name: 'all-cm' }, prefix: 'CM_' }, { secretRef: { name: 'all-sec' } }, {}],
};

describe('probeRows', () => {
  it('describes each probe with its target, timing and live outcome', () => {
    const status: ContainerStatus = { name: 'app', ready: true, started: false };
    const rows = probeRows(container, status, true);
    expect(rows.map((r) => [r.kind, r.target, r.state])).toEqual([
      ['readiness', 'HTTP /ready :8080', 'Ready'],
      ['liveness', 'TCP :http (undeclared)', undefined],
      ['startup', 'gRPC :9090', 'Pending'],
    ]);
    expect(rows[0]!.timing).toBe('delay 0s · period 5s · timeout 1s · fail 3×');
    expect(rows[1]!.timing).toContain('fail 6×');
  });

  it('claims no outcome for finished pods or templates', () => {
    const status: ContainerStatus = { name: 'app', ready: false, started: false };
    expect(probeRows(container, status, false).every((r) => r.state === undefined)).toBe(true);
    expect(probeRows(container, undefined, true).every((r) => r.state === undefined)).toBe(true);
  });

  it('formats HTTPS and exec probes', () => {
    const rows = probeRows(
      { name: 'x', readinessProbe: { httpGet: { scheme: 'HTTPS' } }, livenessProbe: { exec: { command: ['sh', '-c', 'true'] } } },
      undefined,
      false,
    );
    expect(rows.map((r) => r.target)).toEqual(['HTTPS / :', 'exec sh -c true']);
  });
});

describe('mountRows', () => {
  it('joins mounts with the pod volume sources and links referenced objects', () => {
    const rows = mountRows(container, [
      { name: 'config', configMap: { name: 'app-config' } },
      { name: 'cache', emptyDir: {} },
    ]);
    expect(rows).toEqual([
      { path: '/etc/app', volume: 'config', source: 'configMap/app-config', note: 'subPath app.yaml · read-only', refKind: 'ConfigMap', refName: 'app-config' },
      { path: '/cache', volume: 'cache', source: 'emptyDir', note: undefined, refKind: undefined, refName: undefined },
      { path: '/nowhere', volume: 'missing', source: '', note: undefined, refKind: undefined, refName: undefined },
    ]);
  });
});

describe('volumeInfo', () => {
  it('recognizes the navigable sources and falls back to the volume type', () => {
    expect(volumeInfo({ name: 'v', persistentVolumeClaim: { claimName: 'pvc' } })).toMatchObject({ refKind: 'PersistentVolumeClaim', refName: 'pvc' });
    expect(volumeInfo({ name: 'v', secret: { secretName: 's' } })).toMatchObject({ type: 'secret', refKind: 'Secret', refName: 's' });
    expect(volumeInfo({ name: 'v', hostPath: { path: '/var' } })).toEqual({ type: 'hostPath', detail: '/var' });
    expect(volumeLabel({ type: 'hostPath', detail: '/var' })).toBe('hostPath /var');
    expect(volumeLabel({ type: 'downwardAPI', detail: 'metadata.labels' })).toBe('downwardAPI (metadata.labels)');
    expect(volumeLabel({ type: 'secret', detail: 's' })).toBe('secret/s');
    expect(volumeLabel({ type: 'emptyDir' })).toBe('emptyDir');
    expect(volumeInfo({ name: 'v', image: { reference: 'img:1', pullPolicy: 'Always' } })).toEqual({ type: 'image', detail: 'img:1 (Always)' });
    expect(volumeInfo({ name: 'v', projected: {} })).toEqual({ type: 'projected' });
    expect(volumeInfo({ name: 'v', downwardAPI: { items: [{ path: 'ns', fieldRef: { fieldPath: 'metadata.namespace' } }] } })).toEqual({ type: 'downwardAPI', detail: 'metadata.namespace' });
    expect(volumeInfo({ name: 'v' })).toEqual({ type: 'unknown' });
  });
});

describe('named probe ports', () => {
  it('resolves a named port against the container’s ports', () => {
    const rows = probeRows(
      {
        name: 'web',
        ports: [{ name: 'http', containerPort: 9898 }, { name: 'grpc', containerPort: 9999 }],
        readinessProbe: { httpGet: { path: '/readyz', port: 'http' } },
        livenessProbe: { tcpSocket: { port: 'metrics' } },
        startupProbe: { httpGet: { path: '/', port: '8080' } },
      },
      undefined,
      false,
    );
    expect(rows.map((r) => r.target)).toEqual(['HTTP /readyz :http (9898)', 'TCP :metrics (undeclared)', 'HTTP / :8080']);
    expect(probePort(undefined, [])).toBe('');
  });
});

describe('projected volumes', () => {
  it('lists every source, linking the objects it reads', () => {
    const info = volumeInfo(
      {
        name: 'bundle',
        projected: {
          sources: [
            { secret: { name: 'tls' } },
            { configMap: { name: 'settings', optional: true } },
            { serviceAccountToken: { audience: 'vault', expirationSeconds: 3600, path: 'token' } },
            { downwardAPI: { items: [{ path: 'labels', fieldRef: { fieldPath: 'metadata.labels' } }, { path: 'mem', resourceFieldRef: { resource: 'limits.memory' } }] } },
            { clusterTrustBundle: { signerName: 'example.com/ca' } },
          ],
        },
      },
      'app-sa',
    );
    expect(info).toEqual({
      type: 'projected',
      sources: [
        { label: 'secret/tls', refKind: 'Secret', refName: 'tls' },
        { label: 'configMap/settings (optional)', refKind: 'ConfigMap', refName: 'settings' },
        { label: 'serviceAccountToken/app-sa (audience vault, 3600s)', refKind: 'ServiceAccount', refName: 'app-sa' },
        { label: 'downwardAPI (metadata.labels, limits.memory)' },
        { label: 'clusterTrustBundle/example.com/ca' },
      ],
    });
    // Without a service account name the pod runs as "default".
    expect(volumeInfo({ name: 'kube-api-access', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }).sources).toEqual([
      { label: 'serviceAccountToken/default', refKind: 'ServiceAccount', refName: 'default' },
    ]);
  });

  it('carries the sources onto the mount rows', () => {
    const rows = mountRows({ name: 'app', volumeMounts: [{ name: 'bundle', mountPath: '/etc/bundle', readOnly: true }] }, [{ name: 'bundle', projected: { sources: [{ secret: { name: 'tls' } }] } }], 'app-sa');
    expect(rows).toEqual([
      { path: '/etc/bundle', volume: 'bundle', source: 'projected', note: 'read-only', refKind: undefined, refName: undefined, sources: [{ label: 'secret/tls', refKind: 'Secret', refName: 'tls' }] },
    ]);
  });
});

describe('templateEnv', () => {
  it('declares literals, references and envFrom blocks in the pod env shape', () => {
    expect(templateEnv(container)).toEqual([
      { name: 'CM_*', redacted: false, source: { type: 'configMapRef', ref: 'all-cm' } },
      { name: '*', redacted: true, source: { type: 'secretRef', ref: 'all-sec' } },
      { name: 'LITERAL', value: 'yes', source: { type: 'literal' } },
      { name: 'EMPTY', value: '', source: { type: 'literal' } },
      { name: 'FROM_CM', source: { type: 'configMapKeyRef', ref: 'cm', key: 'k' } },
      { name: 'FROM_SECRET', redacted: true, source: { type: 'secretKeyRef', ref: 'sec', key: 'pw' } },
      { name: 'POD_NAME', source: { type: 'fieldRef', key: 'metadata.name' } },
      { name: 'CPU', source: { type: 'resourceFieldRef', key: 'limits.cpu' } },
    ]);
  });
});

describe('containerState', () => {
  it('maps the three container states to a status word', () => {
    expect(containerState(undefined)).toEqual({ shellable: false });
    expect(containerState({ name: 'a', state: { running: {} } })).toEqual({ state: 'Running', shellable: true });
    expect(containerState({ name: 'a', state: { waiting: { reason: 'ImagePullBackOff', message: 'pull failed' } } })).toEqual({
      state: 'ImagePullBackOff',
      message: 'pull failed',
      shellable: false,
    });
    expect(containerState({ name: 'a', state: { waiting: {} } })).toMatchObject({ state: 'Waiting' });
  });

  it('explains a non-zero exit even without a message', () => {
    expect(containerState({ name: 'a', state: { terminated: { reason: 'Error', exitCode: 1 } } })).toEqual({
      state: 'Error',
      message: 'Exited with code 1',
      shellable: false,
    });
    expect(containerState({ name: 'a', state: { terminated: { reason: 'Completed', exitCode: 0 } } })).toEqual({
      state: 'Completed',
      message: undefined,
      shellable: false,
    });
  });
});
