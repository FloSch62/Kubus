import { describe, expect, it } from 'vitest';
import type { GraphNode } from '@kubus/shared';
import { toFlowState } from '../../../client/src/components/TopologyGraphImpl';

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
