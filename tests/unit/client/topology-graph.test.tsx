import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '@kubus/shared';
import { compactLabel, toFlowState } from '../../../client/src/components/TopologyGraphImpl';

describe('compactLabel', () => {
  beforeAll(() => {
    // jsdom has no canvas; measure 7px per character.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D);
  });

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
