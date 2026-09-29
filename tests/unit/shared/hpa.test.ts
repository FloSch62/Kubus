import { describe, expect, it } from 'vitest';
import { hpaMetrics, hpaMetricsSummary, type KubeObject } from '@kubus/shared';

function hpa(spec: Record<string, unknown>, status: Record<string, unknown> = {}): KubeObject {
  return { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: 'web', uid: 'hpa' }, spec, status } as KubeObject;
}

describe('hpaMetrics', () => {
  it('pairs each metric target with its current reading, in the target’s unit', () => {
    const autoscaler = hpa(
      {
        metrics: [
          { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } } },
          { type: 'Resource', resource: { name: 'memory', target: { type: 'AverageValue', averageValue: '64Mi' } } },
          { type: 'ContainerResource', containerResource: { name: 'cpu', container: 'app', target: { type: 'AverageValue', averageValue: '500m' } } },
          { type: 'Pods', pods: { metric: { name: 'requests_per_second' }, target: { type: 'AverageValue', averageValue: '10' } } },
          { type: 'External', external: { metric: { name: 'queue_depth' }, target: { type: 'Value', value: '30' } } },
        ],
      },
      {
        currentMetrics: [
          { type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 42, averageValue: '21m' } } },
          { type: 'Resource', resource: { name: 'memory', current: { averageValue: '14360Ki' } } },
          { type: 'ContainerResource', containerResource: { name: 'cpu', container: 'app', current: { averageValue: '0.25' } } },
          { type: 'Pods', pods: { metric: { name: 'requests_per_second' }, current: { averageValue: '7500m' } } },
        ],
      },
    );
    expect(hpaMetrics(autoscaler)).toEqual([
      { label: 'cpu', current: '42%', target: '60%' },
      { label: 'memory', current: '14Mi', target: '64Mi' },
      { label: 'cpu (app)', current: '250m', target: '500m' },
      { label: 'requests_per_second', current: '7.5', target: '10' },
      // No reading yet: the target still shows.
      { label: 'queue_depth', current: undefined, target: '30' },
    ]);
    expect(hpaMetricsSummary(autoscaler)).toBe('cpu 42% / 60%, memory 14Mi / 64Mi, cpu (app) 250m / 500m, requests_per_second 7.5 / 10, queue_depth ? / 30');
  });

  it('reads the single CPU target of autoscaling/v1 objects', () => {
    expect(hpaMetrics(hpa({ targetCPUUtilizationPercentage: 80 }, { currentCPUUtilizationPercentage: 12 }))).toEqual([{ label: 'cpu', current: '12%', target: '80%' }]);
    expect(hpaMetricsSummary(hpa({ targetCPUUtilizationPercentage: 80 }))).toBe('cpu ? / 80%');
  });

  it('is empty without metrics and tolerates a null status list', () => {
    expect(hpaMetrics(hpa({}))).toEqual([]);
    expect(hpaMetrics(hpa({ metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 50 } } }] }, { currentMetrics: null }))).toEqual([
      { label: 'cpu', current: undefined, target: '50%' },
    ]);
  });
});
