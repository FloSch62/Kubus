import { describe, expect, it } from 'vitest';
import { belongsTo, belongsToNode, counts, definition, phase, type Located } from '../../../plugins/clabernetes/src/model.js';

const lab: Located = {
  ctx: 'a',
  group: 'c9s.run',
  plural: 'topologies',
  metadata: { name: 'demo', namespace: 'lab', uid: 'new', generation: 2 },
  spec: {
    definition: {
      containerlab: 'name: demo\ntopology:\n  nodes:\n    r1: {}\n    r2: {}\n  links:\n    - endpoints: [r1:eth1, r2:eth1]\n',
    },
  },
};
const node: Located = {
  ctx: 'a',
  group: 'c9s.run',
  plural: 'nodes',
  metadata: { name: 'r1', namespace: 'lab', uid: 'node', labels: { 'c9s.run/topologyOwner': 'demo' } },
  status: { readiness: 'ready' },
};
describe('c9s identity and status', () => {
  it('keeps identically named labs in different clusters/namespaces separate', () => {
    expect(belongsTo(node, lab)).toBe(true);
    expect(belongsTo({ ...node, ctx: 'b' }, lab)).toBe(false);
    expect(belongsTo({ ...node, metadata: { ...node.metadata, namespace: 'other' } }, lab)).toBe(false);
  });
  it('does not adopt stale children from a deleted topology', () => {
    expect(
      belongsTo({ ...node, metadata: { ...node.metadata, ownerReferences: [{ kind: 'Topology', name: 'demo', uid: 'old' }] } }, lab),
    ).toBe(false);
  });
  it('resolves direct Pods without conflating core Nodes with c9s Nodes', () => {
    const pod: Located = {
      ctx: 'a',
      group: '',
      plural: 'pods',
      metadata: { name: 'device', namespace: 'lab', labels: { 'c9s.run/direct-workload': 'r1' } },
    };
    expect(belongsToNode(pod, node)).toBe(true);
    expect(belongsToNode({ ...pod, ctx: 'b' }, node)).toBe(false);
  });
  it('does not show stale readiness as running for a newer generation', () => {
    expect(phase({ ...lab, status: { topologyState: 'running', topologyReady: true, observedGeneration: 1 } })).toBe('Reconciling');
    expect(phase({ ...lab, status: { topologyState: 'running', observedGeneration: 2 } })).toBe('running');
  });
  it('marks Node readiness as reconciling when its pipeline belongs to an earlier generation', () => {
    expect(
      phase({
        ...node,
        metadata: { ...node.metadata, generation: 2 },
        status: {
          readiness: 'ready',
          conditions: [{ type: 'PlanApplied', status: 'True', observedGeneration: 1 }],
        },
      }),
    ).toBe('Reconciling');
  });
  it('reads older topologies without Node/Link CRDs and surfaces malformed YAML', () => {
    expect(counts(lab, [], [])).toEqual({ nodes: 2, ready: null, links: 1 });
    expect(definition({ ...lab, spec: { definition: { containerlab: 'topology: [invalid' } } }).error).toBeTruthy();
  });
  it('keeps an explicit zero controller count instead of guessing from old YAML', () => {
    expect(counts({ ...lab, status: { nodeCount: 0, readyNodeCount: 0, linkCount: 0 } }, [node], [])).toEqual({
      nodes: 0,
      ready: 0,
      links: 0,
    });
  });
});
