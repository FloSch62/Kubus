/* oxlint-disable typescript/unbound-method -- these assertions intentionally inspect mocked methods. */
import type { FastifyBaseLogger } from 'fastify';
import type { KubeObject } from '@kubus/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import {
  installMetricsServer,
  metricsServerStatus,
  METRICS_SERVER_VERSION,
  uninstallMetricsServer,
} from '../../../server/src/kube/metrics-server';
import {
  applyMetricsConfiguration,
  buildMetricsConfiguration,
  installNetworkAgent,
  METRICS_CONFIG_PATH,
  networkAgentStatus,
  NETWORK_AGENT_VERSION,
  uninstallNetworkAgent,
} from '../../../server/src/kube/network-agent';

function handleFor(raw: ReturnType<typeof vi.fn>, namespaceItems: KubeObject[] = []): ClusterHandle {
  return {
    raw: { json: raw },
    watchers: {
      peek: vi.fn(() => (namespaceItems.length ? { items: () => namespaceItems } : undefined)),
    },
    metricsPoller: { available: false, kick: vi.fn(), markUnavailable: vi.fn() },
    networkPoller: { available: false, kick: vi.fn(), markUnavailable: vi.fn() },
  } as unknown as ClusterHandle;
}

function log() {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('metrics-server lifecycle', () => {
  it('server-side applies every pinned manifest resource and adds the optional insecure TLS flag', async () => {
    const raw = vi.fn(async (_path: string, _init?: { method?: string; body?: string }) => ({}));
    const handle = handleFor(raw);
    const result = await installMetricsServer(handle, { insecureTls: true });
    expect(result.applied.length).toBeGreaterThan(8);
    expect(result.applied).toContain('Deployment/kube-system/metrics-server');
    expect(result.applied).toContain('APIService/v1beta1.metrics.k8s.io');
    expect(raw.mock.calls.every(([path, init]) => String(path).includes('fieldManager=kubus&force=true') && init?.method === 'PATCH')).toBe(true);
    const deploymentCall = raw.mock.calls.find(([path]) => String(path).includes('/deployments/metrics-server'))!;
    const deployment = JSON.parse(deploymentCall[1]!.body!);
    const container = deployment.spec.template.spec.containers.find((entry: { name: string }) => entry.name === 'metrics-server');
    expect(container.image).toContain(METRICS_SERVER_VERSION);
    expect(container.args).toContain('--kubelet-insecure-tls');
    expect(deployment.metadata.labels['app.kubernetes.io/managed-by']).toBe('kubus');
    expect(handle.metricsPoller.kick).toHaveBeenCalled();
  });

  it('stops installation at the first apply failure', async () => {
    const raw = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('RBAC denied'));
    await expect(installMetricsServer(handleFor(raw), {})).rejects.toThrow('RBAC denied');
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('uninstalls in reverse order, treats 404 as deleted, records other failures, and clears availability', async () => {
    let call = 0;
    const raw = vi.fn(async (_path: string, _init?: unknown) => {
      call += 1;
      if (call === 2) throw { code: 404 };
      if (call === 3) throw new Error('delete denied');
      if (call === 4) throw 'transport closed';
      return {};
    });
    const handle = handleFor(raw);
    const logger = log();
    const result = await uninstallMetricsServer(handle, logger);
    expect(result.deleted.length).toBeGreaterThan(5);
    expect(result.failed).toEqual([
      expect.objectContaining({ error: 'delete denied' }),
      expect.objectContaining({ error: 'transport closed' }),
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[0]![0]).toContain('/apiservices/v1beta1.metrics.k8s.io');
    expect(handle.metricsPoller.markUnavailable).toHaveBeenCalled();
  });

  it('reports status from either resource, extracts versions, and kicks an unprobed poller', async () => {
    const deployment = {
      metadata: { labels: { 'app.kubernetes.io/managed-by': 'kubus' } },
      spec: { template: { spec: { containers: [{ name: 'sidecar', image: 'x' }, { name: 'metrics-server', image: `registry/metrics-server:${METRICS_SERVER_VERSION}` }] } } },
      status: { readyReplicas: 1 },
    };
    const raw = vi.fn().mockResolvedValueOnce(deployment).mockResolvedValueOnce({ metadata: {} });
    const handle = handleFor(raw);
    expect(await metricsServerStatus(handle)).toEqual({
      installed: true,
      managedByKubus: true,
      ready: true,
      version: METRICS_SERVER_VERSION,
      metricsAvailable: false,
    });
    expect(handle.metricsPoller.kick).toHaveBeenCalled();

    const absentRaw = vi.fn().mockRejectedValue({ code: 404 });
    const absent = handleFor(absentRaw);
    expect(await metricsServerStatus(absent)).toEqual({
      installed: false,
      managedByKubus: false,
      ready: false,
      version: undefined,
      metricsAvailable: false,
    });
    expect(absent.metricsPoller.kick).not.toHaveBeenCalled();

    await expect(metricsServerStatus(handleFor(vi.fn().mockRejectedValue(new Error('API down'))))).rejects.toThrow('API down');
  });
});

describe('network-agent lifecycle', () => {
  it('builds stable sorted MetricsConfiguration resources', () => {
    const config = buildMetricsConfiguration(['zeta', 'alpha']);
    expect(config).toEqual(
      expect.objectContaining({
        apiVersion: 'retina.sh/v1alpha1',
        kind: 'MetricsConfiguration',
        metadata: expect.objectContaining({ name: 'kubus-network-metrics' }),
        spec: expect.objectContaining({ namespaces: { include: ['alpha', 'zeta'] } }),
      }),
    );
    expect((config.spec as { contextOptions: unknown[] }).contextOptions).toHaveLength(4);
  });

  it('applies MetricsConfiguration directly', async () => {
    const raw = vi.fn(async (_path: string, _init?: { body?: string }) => ({}));
    await applyMetricsConfiguration(handleFor(raw), ['apps']);
    expect(raw).toHaveBeenCalledWith(
      `${METRICS_CONFIG_PATH}?fieldManager=kubus&force=true`,
      expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('"apps"') }),
    );
  });

  it('installs the vendored agent, uses cached namespaces, stamps ownership, and starts polling', async () => {
    const raw = vi.fn(async (_path: string, _init?: { body?: string }) => ({}));
    const namespaces = [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'zeta' } },
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'alpha' } },
    ] as KubeObject[];
    const handle = handleFor(raw, namespaces);
    const result = await installNetworkAgent(handle);
    expect(result.applied.length).toBeGreaterThan(5);
    expect(result.applied.at(-1)).toBe('MetricsConfiguration/kubus-network-metrics');
    const daemonSetCall = raw.mock.calls.find(([path]) => String(path).includes('/daemonsets/retina-agent'))!;
    const daemonSet = JSON.parse(daemonSetCall[1]!.body!);
    expect(daemonSet.metadata.labels['app.kubernetes.io/managed-by']).toBe('kubus');
    expect(JSON.stringify(daemonSet)).toContain(NETWORK_AGENT_VERSION);
    const metricsCall = raw.mock.calls.find(([path]) => String(path).startsWith(METRICS_CONFIG_PATH))!;
    expect(JSON.parse(metricsCall[1]!.body!).spec.namespaces.include).toEqual(['alpha', 'zeta']);
    expect(handle.networkPoller.kick).toHaveBeenCalled();
  });

  it('falls back to listing namespaces and propagates non-retryable installation failures', async () => {
    const raw = vi.fn(async (path: string) => {
      if (path === '/api/v1/namespaces') return { items: [{ metadata: { name: 'apps' } }, { metadata: {} }] };
      if (String(path).startsWith(METRICS_CONFIG_PATH)) throw new Error('CRD apply denied');
      return {};
    });
    await expect(installNetworkAgent(handleFor(raw))).rejects.toThrow('CRD apply denied');
    expect(raw.mock.calls.some(([path]) => path === '/api/v1/namespaces')).toBe(true);
  });

  it('uninstalls best-effort and marks live metrics unavailable', async () => {
    let call = 0;
    const raw = vi.fn(async (_path: string, _init?: unknown) => {
      call += 1;
      if (call === 1) throw { code: 404 };
      if (call === 2) throw new Error('forbidden');
      return {};
    });
    const handle = handleFor(raw);
    const logger = log();
    const result = await uninstallNetworkAgent(handle, logger);
    expect(result.deleted).toContain('MetricsConfiguration/kubus-network-metrics');
    expect(result.failed).toEqual([expect.objectContaining({ error: 'forbidden' })]);
    expect(handle.networkPoller.markUnavailable).toHaveBeenCalled();
  });

  it('reports DaemonSet status, ownership, image versions, and absent installs', async () => {
    const daemonSet = {
      metadata: { labels: { 'app.kubernetes.io/managed-by': 'kubus' } },
      spec: { template: { spec: { containers: [{ name: 'retina', image: `ghcr.io/retina/retina-agent:${NETWORK_AGENT_VERSION}` }] } } },
      status: { numberReady: 2, desiredNumberScheduled: 3 },
    };
    const handle = handleFor(vi.fn(async () => daemonSet));
    expect(await networkAgentStatus(handle)).toEqual({
      installed: true,
      managedByKubus: true,
      ready: true,
      version: NETWORK_AGENT_VERSION,
      nodesReady: 2,
      nodesDesired: 3,
      metricsAvailable: false,
    });
    expect(handle.networkPoller.kick).toHaveBeenCalled();

    const absent = handleFor(vi.fn().mockRejectedValue({ code: 404 }));
    expect(await networkAgentStatus(absent)).toEqual({
      installed: false,
      managedByKubus: false,
      ready: false,
      version: undefined,
      nodesReady: 0,
      nodesDesired: 0,
      metricsAvailable: false,
    });
    await expect(networkAgentStatus(handleFor(vi.fn().mockRejectedValue(new Error('down'))))).rejects.toThrow('down');
  });
});
