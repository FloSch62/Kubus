import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '@kubus/shared';
import { compactLabel, layerCaption, toFlowState } from '../../../client/src/components/TopologyGraphImpl';

// jsdom has no canvas; measure 7px per character. The component caches the
// context on first use, so the mock is installed once for the whole file.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 7 }),
  } as unknown as CanvasRenderingContext2D);
});

describe('compactLabel', () => {
  it('keeps names that fit and elides the middle of long ones, keeping the pod suffix', () => {
    expect(compactLabel('podinfo', 140, 'font')).toBe('podinfo');
    const pod = compactLabel('podinfo-5c7cdc845b-cpkl2', 140, 'font');
    expect(pod).toMatch(/^podinfo-5c.*…-cpkl2$/);
    expect(pod.length * 7).toBeLessThanOrEqual(140);
    const long = compactLabel('kube-controller-manager-kubus-a-control-plane', 140, 'font');
    expect(long.endsWith('-plane')).toBe(true);
    expect(long.length * 7).toBeLessThanOrEqual(140);
  });
});

describe('layerCaption', () => {
  const node = (kind: string, layer: GraphNode['layer']): GraphNode => ({
    id: `${kind}/x`,
    label: 'x',
    layer,
    status: 'success',
    ref: { ctx: 'dev', group: '', version: 'v1', plural: 'x', kind, name: 'x', namespace: 'demo' },
  });

  it('names the layer beside the kind', () => {
    expect(layerCaption(node('Job', 'workload'), 'font')).toBe('WORKLOAD');
    expect(layerCaption(node('Ingress', 'entry'), 'font')).toBe('ENTRY');
    expect(layerCaption(node('ConfigMap', 'storage'), 'font')).toBe('STORAGE');
  });

  it('leaves it out when it repeats the kind, says nothing, or does not fit', () => {
    expect(layerCaption(node('Pod', 'pod'), 'font')).toBeUndefined();
    expect(layerCaption(node('Service', 'service'), 'font')).toBeUndefined();
    expect(layerCaption(node('Widget', 'other'), 'font')).toBeUndefined();
    expect(layerCaption(node('HorizontalPodAutoscaler', 'workload'), 'font')).toBeUndefined();
  });
});

describe('topology flow state', () => {
  it('lets the graph-level lock control node movement', () => {
    const graphNode: GraphNode = {
      id: 'pod/team-a/web-0',
      label: 'web-0',
      layer: 'workload',
      status: 'success',
      ref: {
        ctx: 'dev',
        group: '',
        version: 'v1',
        plural: 'pods',
        kind: 'Pod',
        name: 'web-0',
        namespace: 'team-a',
      },
    };

    const flow = toFlowState({
      nodes: [{ node: graphNode, position: { x: 0, y: 0 } }],
      edges: [],
      warnings: [],
      problemNodes: [],
    });

    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0]).not.toHaveProperty('draggable');
  });
});
