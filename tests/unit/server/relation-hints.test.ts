import { describe, expect, it } from 'vitest';
import {
  collectMapSelectors,
  createPathFilter,
  descriptionNamesKind,
  digestObject,
  hintPath,
  kindHeadTerms,
  kindPathCoverage,
  kindVocabulary,
  looksLikeName,
  pathNamesKind,
  referencePath,
  relationPathScore,
  schemaFieldDescription,
  schemaKindMention,
  schemaMentionsKind,
  textNamesKind,
  tokens,
} from '../../../server/src/kube/relation-hints';

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
    // Generic leaves never count on their own, but a `name` leaf defers to its parent.
    expect(relationPathScore({ path: 'spec.node.kind', value: 'x' }, { kind: 'TopoNode', plural: 'toponodes' })).toBe(0);
    expect(relationPathScore({ path: 'spec.secretRef.name', value: 'x' }, { kind: 'Secret', plural: 'secrets' })).toBeGreaterThan(0);
    expect(relationPathScore({ path: 'metadata.name', value: 'x' }, { kind: 'Secret', plural: 'secrets' })).toBe(0);
    expect(referencePath('spec.links[0].local.node')).toBe('spec.links[0].local.node');
    expect(referencePath('spec.configMapRef.name')).toBe('spec.configMapRef');
    expect(referencePath('name')).toBeUndefined();
    expect(referencePath('spec.node.namespace')).toBeUndefined();
    expect(pathNamesKind('spec.configMapRef.name', 'ConfigMap')).toBe(true);
  });

  it('finds map-shaped selectors and leaves lists and scalars alone', () => {
    expect(collectMapSelectors({ spec: { podSelector: { matchLabels: { app: 'web' } }, selector: { tier: 'db' }, nodeSelector: ['role=leaf'], deep: [{ endpointSelector: { matchLabels: {} } }] } })).toEqual([
      { path: 'spec.podSelector.matchLabels', selector: { app: 'web' } },
      { path: 'spec.selector', selector: { tier: 'db' } },
    ]);
  });

  it('digests an object down to the fields that can name a known kind, plus selectors', () => {
    const namesKind = createPathFilter(kindVocabulary(['TopoNode', 'Interface', 'Secret']));
    const digest = digestObject(
      {
        metadata: { name: 'link', uid: 'u' },
        spec: {
          description: 'uplink',
          links: [{ local: { node: 'l001', interfaceResource: 'l001-e1', speed: '100G' }, remote: { node: 's001', kind: 'TopoNode', namespace: 'eda' } }],
          nodeType: 'SIMPLE',
          nodeSelectors: ['role=leaf'],
          podSelector: { matchLabels: { app: 'x' } },
          secretRef: { name: 'db' },
        },
        status: { health: 'up', members: [{ node: 'l001' }] },
      },
      namesKind,
    );
    expect(digest.hints).toEqual([
      { path: 'spec.links[0].local.node', value: 'l001' },
      { path: 'spec.links[0].local.interfaceResource', value: 'l001-e1' },
      { path: 'spec.links[0].remote.node', value: 's001', referenceKind: 'TopoNode', referenceNamespace: 'eda' },
      // The `kind` leaf itself is dropped: `TopoNode` is not a name.
      { path: 'spec.links[0].remote.namespace', value: 'eda', referenceKind: 'TopoNode', referenceNamespace: 'eda' },
      { path: 'spec.secretRef.name', value: 'db' },
      { path: 'status.members[0].node', value: 'l001' },
    ]);
    expect(digest.selectors).toEqual([{ path: 'spec.nodeSelectors[0]', selector: { role: 'leaf' } }]);
    // Values that cannot be object names (enums, versions with spaces) never make it into a digest.
    expect(digest.hints.some((h) => h.value === 'SIMPLE')).toBe(false);
    expect(looksLikeName('demo-bd-a')).toBe(true);
    expect(looksLikeName('srlinux-ghcr-25.7.1')).toBe(true);
    expect(looksLikeName('SIMPLE')).toBe(false);
    expect(looksLikeName('7220 IXR-H2')).toBe(false);
    expect(looksLikeName('-bad')).toBe(false);
    // The memo answers the same path shape without re-tokenizing.
    expect(namesKind('spec.links[7].local.node')).toBe(true);
    expect(namesKind('spec.description')).toBe(false);
  });

  it('reads a field description out of a CRD schema and recognizes kinds named in prose', () => {
    const object = (properties: Record<string, unknown>, description?: string) => ({ type: 'object', properties, ...(description ? { description } : {}) });
    const schema = object({
      spec: object({
        links: { type: 'array', description: 'Links of this topology.', items: object({ local: object({ node: { type: 'string', description: 'Reference to a TopoNode.' } }) }) },
        leafNodeSelectors: { type: 'array', description: 'Label selector used to select Toponodes.', items: { type: 'string' } },
      }),
    });
    expect(schemaFieldDescription(schema, 'spec.links[0].local.node')).toBe('Reference to a TopoNode.');
    expect(schemaFieldDescription(schema, 'spec.leafNodeSelectors[2]')).toBe('Label selector used to select Toponodes.');
    expect(schemaFieldDescription(schema, 'spec.links[0].remote.node')).toBe('Links of this topology.');
    expect(schemaFieldDescription(undefined, 'spec.x')).toBeUndefined();
    expect(textNamesKind('Reference to a TopoNode.', 'TopoNode')).toBe(true);
    expect(textNamesKind('Label selector used to select Toponodes.', 'TopoNode')).toBe(true);
    expect(textNamesKind('Reference to an Interface object.', 'Interface')).toBe(true);
    expect(textNamesKind('Interfaces to configure.', 'Interface')).toBe(true);
    // Short single words are everyday nouns, not kind names, and single-word kinds must be written as kinds.
    expect(textNamesKind('Node name.', 'Node')).toBe(false);
    expect(textNamesKind('The interface speed.', 'TopoNode')).toBe(false);
    expect(textNamesKind('The interface speed.', 'Interface')).toBe(false);
    expect(textNamesKind('Protocol to use for the service.', 'Service')).toBe(false);
    // A description is a reference only when it says so.
    expect(descriptionNamesKind('Reference to a TopoNode.', 'TopoNode')).toBe(true);
    expect(descriptionNamesKind('Label selector used to select Toponodes.', 'TopoNode')).toBe(true);
    expect(descriptionNamesKind('Name of the NodeProfile to use.', 'NodeProfile')).toBe(true);
    expect(descriptionNamesKind('Platform of the TopoNode.', 'TopoNode')).toBe(false);
    expect(descriptionNamesKind('Description of the Interface.', 'Interface')).toBe(false);
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
