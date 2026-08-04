import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../../server/src/app';
import type { ClusterHandle } from '../../../server/src/kube/cluster-manager';
import { registerMetricsRoutes } from '../../../server/src/routes/metrics';

describe('metrics routes', () => {
  it('returns full node capacity separately from allocatable resources', async () => {
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
        items: [
          {
            name: 'node-a',
            cpuMilli: 250,
            memBytes: 2 ** 30,
            cpuCapacityMilli: 3500,
            memCapacityBytes: 7 * 2 ** 30,
            cpuNodeCapacityMilli: 4000,
            memNodeCapacityBytes: 8 * 2 ** 30,
          },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
