import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { discoverLabs, labCounts, labGraph, labPods, labRuntime, linkWiring } from '../../../plugins/clabernetes/src/labs.js';
import { phase, type Located } from '../../../plugins/clabernetes/src/model.js';
const r = (plural: string, name: string, spec: Record<string, unknown> = {}): Located => ({
  ctx: 'a',
  group: 'c9s.run',
  plural,
  metadata: { name, namespace: 'lab', uid: name, generation: 2 },
  spec,
});
const nodes = ['r1', 'r2'].map((name) => ({
  ...r('nodes', name, { kind: 'linux', image: 'alpine' }),
  status: { conditions: [{ type: 'ConnectivityReady', status: 'True', observedGeneration: 2 }] },
}));
const link = {
  ...r('links', 'wire', { endpointA: { nodeName: 'r1', interfaceName: 'eth1' }, endpointB: { nodeName: 'r2', interfaceName: 'eth1' } }),
  status: {
    conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 2 }],
    resolvedEndpoints: { endpointA: { nodeName: 'r1', uid: 'r1' }, endpointB: { nodeName: 'r2', uid: 'r2' } },
  },
};
describe('namespace lab workspaces', () => {
  it('discovers and renders a lab composed only of Nodes and Links', () => {
    const [lab] = discoverLabs([...nodes, link]);
    expect(lab?.name).toBe('lab');
    expect(lab?.topologies).toEqual([]);
    const graph = labGraph(lab!);
    expect(graph.generated).toBe(true);
    expect(load(graph.yaml)).toMatchObject({
      topology: { nodes: { r1: { kind: 'linux' }, r2: { kind: 'linux' } }, links: [{ endpoints: ['r1:eth1', 'r2:eth1'] }] },
    });
  });
  it('keeps clusters and namespaces separate and combines mixed authoring in one workspace', () => {
    const topology = r('topologies', 'shortcut', { definition: { containerlab: 'name: shortcut\ntopology:\n  nodes: {}' } });
    const labs = discoverLabs([
      topology,
      ...nodes,
      link,
      { ...nodes[0]!, ctx: 'b' },
      { ...nodes[0]!, metadata: { ...nodes[0]!.metadata, namespace: 'other' } },
    ]);
    expect(labs).toHaveLength(3);
    const mixed = labs.find((l) => l.ctx === 'a' && l.namespace === 'lab')!;
    expect(mixed.nodes).toHaveLength(2);
    expect(labGraph(mixed).generated).toBe(true);
  });
  it('retains the original definition for a wholly Topology-managed namespace', () => {
    const topology = r('topologies', 'shortcut', { definition: { containerlab: 'name: shortcut\ntopology:\n  nodes: {}' } });
    const child = {
      ...nodes[0]!,
      metadata: { ...nodes[0]!.metadata, ownerReferences: [{ kind: 'Topology', name: 'shortcut', uid: 'shortcut' }] },
    };
    const lab = discoverLabs([topology, child])[0]!;
    expect(lab.name).toBe('shortcut');
    expect(labGraph(lab).generated).toBe(false);
  });
  it('includes directly managed Nodes alongside a Topology still creating its devices', () => {
    const topology = { ...r('topologies', 'shortcut'), status: { nodeCount: 4 } };
    const child = { ...nodes[0]!, metadata: { ...nodes[0]!.metadata, labels: { 'c9s.run/topologyOwner': 'shortcut' } } };
    expect(labCounts(discoverLabs([topology, child, nodes[1]!])[0]!).nodes).toBe(5);
  });
  it('finds standalone workloads, mounted claims and selector-based services without including unrelated Pods', () => {
    const lab = discoverLabs(nodes)[0]!;
    const pod: Located = {
      ...r('pods', 'r1-pod'),
      group: '',
      metadata: { name: 'r1-pod', namespace: 'lab', labels: { 'c9s.run/direct-workload': 'r1' } },
      spec: { volumes: [{ persistentVolumeClaim: { claimName: 'retained' } }] },
    };
    expect(labPods(lab, [pod, r('pods', 'unrelated')])).toEqual([pod]);
    expect(labRuntime(r('persistentvolumeclaims', 'retained'), lab, [pod])).toBe(true);
    expect(labRuntime(r('services', 'access', { selector: { 'c9s.run/direct-workload': 'r1' } }), lab, [pod])).toBe(true);
    expect(labRuntime(r('services', 'unrelated', { selector: {} }), lab, [pod])).toBe(false);
  });
});
describe('Link wiring evidence', () => {
  it('reports endpoint wiring without calling configuration acceptance carrier-up', () => {
    expect(linkWiring(link, nodes).label).toBe('Ready');
    expect(
      linkWiring(
        link,
        nodes.map((n) => ({ ...n, status: { conditions: [] } })),
      ).label,
    ).toBe('Unknown');
  });
  it('surfaces failed wiring and stale Node generations', () => {
    expect(
      linkWiring(link, [
        nodes[0]!,
        {
          ...nodes[1]!,
          status: { conditions: [{ type: 'ConnectivityReady', status: 'False', observedGeneration: 2, reason: 'PeerUnavailable' }] },
        },
      ]).label,
    ).toBe('Not ready');
    expect(linkWiring(link, [{ ...nodes[0]!, metadata: { ...nodes[0]!.metadata, generation: 3 } }, nodes[1]!]).label).toBe('Unknown');
  });
  it('rejects replaced endpoint identities and stale Link acceptance', () => {
    expect(linkWiring(link, [{ ...nodes[0]!, metadata: { ...nodes[0]!.metadata, uid: 'new' } }, nodes[1]!]).label).toBe('Unknown');
    expect(linkWiring({ ...link, metadata: { ...link.metadata, generation: 3 } }, nodes).label).toBe('Reconciling');
    expect(phase({ ...link, metadata: { ...link.metadata, generation: 3 } })).toBe('Reconciling');
  });
});
