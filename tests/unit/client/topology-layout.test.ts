import type { GraphEdge, GraphNode, RelationshipGraph } from '@kubus/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { elkLayoutCalls } from '../../setup/mock-elk';

const topologyLayout = await import('../../../client/src/components/topology-layout');
const { NODE_WIDTH, cachedTopologyLayout, estimateNodeHeight, foldIdleReplicaSets, isFoldedReplicaSets, layoutTopology, routeEdges, topologyNodeBox } = topologyLayout;
type LayoutBox = import('../../../client/src/components/topology-layout').LayoutBox;

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    ref: { ctx: 'kind-a', group: '', version: 'v1', plural: 'pods', kind: 'Pod', name: id, namespace: 'default' },
    label: id,
    layer: 'pod',
    status: 'success',
    ...overrides,
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target, kind: 'owns' };
}

describe('topology node sizing', () => {
  it('accounts for optional secondary rows', () => {
    expect(estimateNodeHeight(node('plain'))).toBe(50);
    expect(estimateNodeHeight(node('sub', { sublabel: 'default' }))).toBe(67);
    expect(estimateNodeHeight(node('reason', { reason: 'CrashLoopBackOff' }))).toBe(67);
    expect(estimateNodeHeight(node('both', { sublabel: 'default', reason: 'Not ready' }))).toBe(84);
  });

  it('builds the matching obstacle box', () => {
    expect(topologyNodeBox('pod-1', { x: 12, y: 34 }, node('pod-1', { reason: 'bad' }))).toEqual({
      id: 'pod-1',
      x: 12,
      y: 34,
      width: NODE_WIDTH,
      height: 67,
    });
  });
});

describe('routeEdges', () => {
  it('uses a compact direct orthogonal route between clear forward nodes', () => {
    const boxes: LayoutBox[] = [
      { id: 'a', x: 0, y: 0, width: 100, height: 80 },
      { id: 'b', x: 300, y: 120, width: 100, height: 80 },
    ];
    expect(routeEdges(boxes, [{ id: 'a-b', source: 'a', target: 'b' }]).get('a-b')).toEqual([
      { x: 100, y: 40 },
      { x: 200, y: 40 },
      { x: 200, y: 160 },
      { x: 300, y: 160 },
    ]);
  });

  it('routes around intervening obstacles and reverse edges', () => {
    const boxes: LayoutBox[] = [
      { id: 'a', x: 0, y: 80, width: 100, height: 80 },
      { id: 'block', x: 150, y: 40, width: 120, height: 160 },
      { id: 'b', x: 340, y: 80, width: 100, height: 80 },
    ];
    const routes = routeEdges(boxes, [
      { id: 'forward', source: 'a', target: 'b' },
      { id: 'reverse', source: 'b', target: 'a' },
      { id: 'missing', source: 'none', target: 'a' },
    ]);

    for (const id of ['forward', 'reverse']) {
      const points = routes.get(id);
      expect(points?.length).toBeGreaterThan(4);
      expect(points?.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    }
    expect(routes.has('missing')).toBe(false);
  });

  it('handles empty, touching, overlapping, vertical, and densely blocked layouts', () => {
    expect(routeEdges([], [{ id: 'x', source: 'a', target: 'b' }]).size).toBe(0);

    const cases: LayoutBox[][] = [
      [
        { id: 'a', x: 0, y: 0, width: 100, height: 80 },
        { id: 'b', x: 100, y: 0, width: 100, height: 80 },
      ],
      [
        { id: 'a', x: 100, y: 0, width: 100, height: 80 },
        { id: 'b', x: 100, y: 200, width: 100, height: 80 },
      ],
      [
        { id: 'a', x: 50, y: 50, width: 100, height: 80 },
        { id: 'b', x: 80, y: 70, width: 100, height: 80 },
        { id: 'c', x: -10, y: -10, width: 300, height: 220 },
      ],
    ];

    for (const boxes of cases) {
      const points = routeEdges(boxes, [{ id: 'edge', source: 'a', target: 'b' }]).get('edge');
      expect(points?.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('layoutTopology', () => {
  beforeEach(() => {
    elkLayoutCalls.length = 0;
  });

  it('lays out graphs, stacks them, collects problems and warnings, and caches each mode', async () => {
    const graphs: RelationshipGraph[] = [
      {
        ctx: 'kind-a',
        nodes: [
          node('service', { layer: 'service' }),
          node('pod', { status: 'warning', reason: 'Not ready' }),
          node('orphan', { layer: 'other' }),
        ],
        edges: [edge('service-pod', 'service', 'pod')],
        warnings: ['partial discovery'],
      },
      {
        ctx: 'kind-b',
        nodes: [node('broken', { status: 'error', layer: 'workload' })],
        edges: [],
        warnings: [],
      },
    ];

    expect(cachedTopologyLayout(undefined, false)).toBeUndefined();
    const full = await layoutTopology(graphs, false);
    expect(full.nodes.map((placed) => placed.node.id)).toEqual(['service', 'pod', 'orphan', 'broken']);
    expect(full.edges).toHaveLength(1);
    expect(full.warnings).toEqual(['kind-a: partial discovery']);
    expect(full.problemNodes.map((problem) => problem.id)).toEqual(['pod', 'broken']);
    expect(full.nodes[3]!.position.y).toBeGreaterThan(full.nodes[1]!.position.y);
    expect(cachedTopologyLayout(graphs, false)).toBe(full);
    expect(await layoutTopology(graphs, false)).toBe(full);
    expect(elkLayoutCalls).toHaveLength(2);

    const filtered = await layoutTopology(graphs, true);
    expect(filtered.nodes.map((placed) => placed.node.id)).toEqual(['service', 'pod', 'broken']);
    expect(cachedTopologyLayout(graphs, true)).toBe(filtered);
    expect(elkLayoutCalls).toHaveLength(4);
  });

  it('returns an empty layout for missing graphs and ignores empty filtered graphs', async () => {
    expect(await layoutTopology(undefined, false)).toEqual({
      nodes: [],
      edges: [],
      warnings: [],
      problemNodes: [],
    });

    const graphs: RelationshipGraph[] = [{ ctx: 'kind-a', nodes: [node('orphan')], edges: [], warnings: ['warn'] }];
    const result = await layoutTopology(graphs, true);
    expect(result.nodes).toEqual([]);
    expect(result.warnings).toEqual(['kind-a: warn']);
  });
});

describe('foldIdleReplicaSets', () => {
  const deployment = node('deploy', { layer: 'workload' });
  const rs = (id: string, overrides: Partial<GraphNode> = {}) => node(id, { layer: 'replicaset', ...overrides });

  it('folds healthy idle ReplicaSets of a workload that still has pods', () => {
    const graph: RelationshipGraph = {
      ctx: 'kind-a',
      nodes: [deployment, rs('rs-new'), rs('rs-old-1'), rs('rs-old-2'), node('pod-1')],
      edges: [edge('d-new', 'deploy', 'rs-new'), edge('d-old-1', 'deploy', 'rs-old-1'), edge('d-old-2', 'deploy', 'rs-old-2'), edge('new-pod', 'rs-new', 'pod-1')],
      warnings: [],
    };
    const folded = foldIdleReplicaSets(graph);
    expect(folded.nodes.map((n) => n.id)).toEqual(['deploy', 'rs-new', 'pod-1', 'folded-replicasets:deploy']);
    const placeholder = folded.nodes.at(-1)!;
    expect(isFoldedReplicaSets(placeholder)).toBe(true);
    expect(placeholder.label).toBe('2 old ReplicaSets');
    expect(folded.edges.map((e) => e.id)).toEqual(['d-new', 'new-pod', 'folded-replicasets:deploy:owns']);
  });

  it('keeps ReplicaSets that report a problem or belong to a workload scaled to zero', () => {
    const stuck: RelationshipGraph = {
      ctx: 'kind-a',
      nodes: [deployment, rs('rs-old'), rs('rs-new', { status: 'error', reason: 'exceeded quota' }), node('pod-1')],
      edges: [edge('d-old', 'deploy', 'rs-old'), edge('d-new', 'deploy', 'rs-new'), edge('old-pod', 'rs-old', 'pod-1')],
      warnings: [],
    };
    expect(foldIdleReplicaSets(stuck)).toBe(stuck);

    const scaledToZero: RelationshipGraph = {
      ctx: 'kind-a',
      nodes: [deployment, rs('rs-a'), rs('rs-b')],
      edges: [edge('d-a', 'deploy', 'rs-a'), edge('d-b', 'deploy', 'rs-b')],
      warnings: [],
    };
    expect(foldIdleReplicaSets(scaledToZero)).toBe(scaledToZero);
  });

  it('caches folded and unfolded layouts separately', async () => {
    const graphs: RelationshipGraph[] = [
      {
        ctx: 'kind-a',
        nodes: [deployment, rs('rs-new'), rs('rs-old'), node('pod-1')],
        edges: [edge('d-new', 'deploy', 'rs-new'), edge('d-old', 'deploy', 'rs-old'), edge('new-pod', 'rs-new', 'pod-1')],
        warnings: [],
      },
    ];
    const plain = await layoutTopology(graphs, false);
    const folded = await layoutTopology(graphs, false, true);
    expect(plain.nodes).toHaveLength(4);
    expect(folded.nodes.map((placed) => placed.node.id)).toContain('folded-replicasets:deploy');
    expect(cachedTopologyLayout(graphs, false)).toBe(plain);
    expect(cachedTopologyLayout(graphs, false, true)).toBe(folded);
  });
});
