import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { registerMetricsRoutes } from '../../../server/src/routes/metrics';

describe('metrics routes', () => {
  it('aggregates full capacity from every watched node, including unsampled nodes', async () => {
    const handle = {
      metricsPoller: {
        available: true,
        probed: true,
        nodeSnapshot: () => [{ name: 'node-a', cpuMilli: 250, memBytes: 2 ** 30 }],
      },
      watchers: {
        peek: () => ({
          items: () => [
            {
              metadata: { name: 'node-a' },
              status: {
                capacity: { cpu: '4', memory: '8Gi' },
                allocatable: { cpu: '3500m', memory: '7Gi' },
              },
            },
            {
              metadata: { name: 'node-b' },
              status: {
                capacity: { cpu: '2', memory: '4Gi' },
                allocatable: { cpu: '1500m', memory: '3Gi' },
              },
            },
          ],
        }),
      },
    } as unknown as ClusterHandle;
    const app = Fastify();
    registerMetricsRoutes(app, { clusters: { get: () => handle } } as unknown as AppContext);

    try {
      const response = await app.inject({ method: 'GET', url: '/api/contexts/dev/metrics/nodes' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        available: true,
        probed: true,
        totalCpuCapacityMilli: 6000,
        totalMemCapacityBytes: 12 * 2 ** 30,
        items: [
          {
            name: 'node-a',
            cpuMilli: 250,
            memBytes: 2 ** 30,
            cpuCapacityMilli: 3500,
            memCapacityBytes: 7 * 2 ** 30,
          },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
