import { describe, expect, it } from 'vitest';
import { hintPath, kindHeadTerms, kindPathCoverage, pathNamesKind, relationPathScore, schemaKindMention, schemaMentionsKind, tokens } from '../../../server/src/kube/relation-hints';

describe('relation hints', () => {
  it('tokenizes camel case, dotted paths and label keys, singularized and without filler words', () => {
    expect(tokens('spec.leafs.leafNodeSelectors[0]')).toEqual(['leaf', 'leaf', 'node', 'selector', '0']);
    expect(tokens('services.eda.nokia.com/virtualnetwork')).toEqual(['service', 'eda', 'nokia', 'com', 'virtualnetwork']);
    expect(tokens('IPAllocationPools')).toEqual(['ip', 'allocation', 'pool']);
    expect(tokens('metadata.name')).toEqual([]);
  });

  it('names a kind by its head word or its full name', () => {
    expect([...kindHeadTerms('TopoNode')].sort()).toEqual(['node', 'toponode']);
    expect([...kindHeadTerms('ConfigMap')].sort()).toEqual(['configmap', 'map']);
    expect(pathNamesKind('spec.members[0].node', 'TopoNode')).toBe(true);
    expect(pathNamesKind('spec.nodeProfile', 'TopoNode')).toBe(true);
    expect(pathNamesKind('spec.configMapRef.name', 'ConfigMap')).toBe(true);
    expect(pathNamesKind('spec.config', 'ConfigMap')).toBe(false);
    expect(pathNamesKind('services.eda.nokia.com/virtualnetwork', 'VirtualNetwork')).toBe(true);
    expect(pathNamesKind('spec.eviPool', 'IndexAllocationPool')).toBe(true);
    expect(hintPath('spec.links[0].local.node')).toBe('spec.links.local.node');
  });

  it('scores a path higher when it spells out the whole kind, and lets a sibling kind field decide', () => {
    const label = { path: 'services.eda.nokia.com/virtualnetwork', value: 'vn-a' };
    expect(relationPathScore(label, { kind: 'VirtualNetwork', plural: 'virtualnetworks' })).toBeGreaterThan(relationPathScore(label, { kind: 'Network', plural: 'networks' }));
    expect(relationPathScore({ path: 'spec.nodeProfile', value: 'x' }, { kind: 'NodeProfile', plural: 'nodeprofiles' })).toBeGreaterThan(
      relationPathScore({ path: 'spec.nodeProfile', value: 'x' }, { kind: 'TopoNode', plural: 'toponodes' }),
    );
    expect(relationPathScore({ path: 'spec.targetRef.name', value: 'x', referenceKind: 'TopoNode' }, { kind: 'TopoNode', plural: 'toponodes' })).toBeGreaterThanOrEqual(100);
    expect(relationPathScore({ path: 'spec.nodeRef.name', value: 'x', referenceKind: 'Node' }, { kind: 'TopoNode', plural: 'toponodes' })).toBe(0);
    // Generic leaves never count on their own.
    expect(relationPathScore({ path: 'spec.node.kind', value: 'x' }, { kind: 'TopoNode', plural: 'toponodes' })).toBe(0);
  });

  it('counts how many words of a path a kind covers, so a one-word kind never outranks the kind it heads', () => {
    expect(kindPathCoverage('spec.nodeProfile', { kind: 'NodeProfile', plural: 'nodeprofiles' })).toBe(2);
    expect(kindPathCoverage('spec.nodeProfile', { kind: 'TopoNode', plural: 'toponodes' })).toBe(1);
    expect(kindPathCoverage('spec.links[0].local.node', { kind: 'Node', plural: 'nodes' })).toBe(1);
    expect(kindPathCoverage('spec.links[0].local.node', { kind: 'TopoNode', plural: 'toponodes' })).toBe(1);
    expect(kindPathCoverage('services.eda.nokia.com/virtualnetwork', { kind: 'VirtualNetwork', plural: 'virtualnetworks' })).toBe(1);
    expect(kindPathCoverage('services.eda.nokia.com/virtualnetwork', { kind: 'Network', plural: 'networks' })).toBe(0);
  });

  it('checks a CRD schema for fields named after a kind, under spec and status only', () => {
    const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
    const schema = object({
      metadata: object({ node: { type: 'string' } }),
      spec: object({ links: { type: 'array', items: object({ local: object({ interfaceResource: { type: 'string' } }) }) } }),
      status: object({ nodeState: { type: 'string' } }),
    });
    expect(schemaMentionsKind(schema, 'Interface')).toBe(true);
    expect(schemaMentionsKind(schema, 'TopoNode')).toBe(true);
    expect(schemaMentionsKind(schema, 'BridgeDomain')).toBe(false);
    // A field spelling out the whole kind is a strong mention; the head word alone is weak, and weaker still under status only.
    expect(schemaKindMention(schema, 'Interface')).toEqual({ strength: 'strong', inSpec: true });
    expect(schemaKindMention(schema, 'TopoNode')).toEqual({ strength: 'weak', inSpec: false });
    expect(schemaKindMention(object({ spec: object({ topoNodeRef: { type: 'string' } }) }), 'TopoNode')).toEqual({ strength: 'strong', inSpec: true });
    expect(schemaKindMention(object({ spec: object({ nodeProfile: { type: 'string' } }) }), 'NodeProfile')).toEqual({ strength: 'strong', inSpec: true });
    expect(schemaKindMention(object({ spec: object({ secretName: { type: 'string' } }) }), 'Secret')).toEqual({ strength: 'strong', inSpec: true });
    // A description that names the kind counts as much as the field name.
    expect(schemaKindMention(object({ spec: object({ node: { type: 'string', description: 'Reference to a TopoNode.' } }) }), 'TopoNode')).toEqual({ strength: 'strong', inSpec: true });
    expect(schemaKindMention(object({ spec: object({ leafNodeSelectors: { type: 'array', description: 'Label selector used to select Toponodes.', items: { type: 'string' } } }) }), 'TopoNode')).toEqual({ strength: 'strong', inSpec: true });
    expect(schemaKindMention(object({ spec: object({ node: { type: 'string', description: 'Node name.' } }) }), 'TopoNode')).toEqual({ strength: 'weak', inSpec: true });
    expect(schemaMentionsKind(undefined, 'TopoNode')).toBe(false);
    expect(schemaMentionsKind(object({ spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } }), 'TopoNode')).toBe(false);
  });
});
