import { describe, expect, it } from 'vitest';
import {
  defaultExpanded,
  deleteAt,
  diffChanges,
  displayPath,
  editorKindFor,
  emptyValueFor,
  filterTree,
  getAt,
  hasAt,
  hasNaturalKeys,
  insertAt,
  itemLabel,
  lockReason,
  manifestGroups,
  parseScalarInput,
  parseYamlMapping,
  pointerOf,
  rebaseEdits,
  referenceAt,
  setAt,
  splitApiVersion,
  suggestedKeys,
  collapsedPreview,
  compactType,
  normalizeDescription,
} from '../../../client/src/components/detail/manifest-tree';
import { schemaAt, schemaDefinitions } from '../../../client/src/components/detail/schema-walk';

const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'team-a', labels: { 'app.kubernetes.io/name': 'web' } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'web' } },
    template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }, { name: 'sidecar', image: 'busybox' }] } },
  },
  status: { readyReplicas: 2, conditions: [{ type: 'Available', status: 'True' }] },
};

describe('paths', () => {
  it('builds RFC 6901 pointers and kubectl-style display paths', () => {
    expect(pointerOf(['metadata', 'labels', 'app.kubernetes.io/name'])).toBe('/metadata/labels/app.kubernetes.io~1name');
    expect(pointerOf(['spec', 'containers', 0, 'a~b'])).toBe('/spec/containers/0/a~0b');
    expect(displayPath(['spec', 'template', 'spec', 'containers', 0, 'image'])).toBe('.spec.template.spec.containers[0].image');
    expect(displayPath(['metadata', 'labels', 'app.kubernetes.io/name'])).toBe('.metadata.labels["app.kubernetes.io/name"]');
  });

  it('reads, writes, inserts and deletes immutably', () => {
    expect(getAt(deployment, ['spec', 'template', 'spec', 'containers', 1, 'name'])).toBe('sidecar');
    expect(getAt(deployment, ['spec', 'missing', 'deeper'])).toBeUndefined();
    expect(hasAt(deployment, ['spec', 'replicas'])).toBe(true);
    expect(hasAt(deployment, ['spec', 'paused'])).toBe(false);
    expect(hasAt(deployment, ['spec', 'template', 'spec', 'containers', 5])).toBe(false);

    const scaled = setAt(deployment, ['spec', 'replicas'], 3);
    expect(scaled.spec.replicas).toBe(3);
    expect(deployment.spec.replicas).toBe(2);
    expect(scaled.metadata).toBe(deployment.metadata);

    const created = setAt(deployment, ['metadata', 'annotations', 'team'], 'a');
    expect(created.metadata).toMatchObject({ annotations: { team: 'a' } });

    const inserted = insertAt(deployment, ['spec', 'template', 'spec', 'containers'], 99, { name: 'extra' });
    expect(inserted.spec.template.spec.containers.map((c) => c.name)).toEqual(['nginx', 'sidecar', 'extra']);

    const trimmed = deleteAt(deployment, ['spec', 'template', 'spec', 'containers', 0]);
    expect(trimmed.spec.template.spec.containers.map((c) => c.name)).toEqual(['sidecar']);
    const withoutLabels = deleteAt(deployment, ['metadata', 'labels']);
    expect(withoutLabels.metadata).not.toHaveProperty('labels');
    expect(deleteAt(deployment, ['spec', 'nope'])).toBe(deployment);
    expect(deleteAt(deployment, ['spec', 'template', 'spec', 'containers', 7])).toBe(deployment);
  });
});

describe('change tracking', () => {
  it('reports added, removed and changed rows with their ancestors', () => {
    let draft = setAt(deployment, ['spec', 'replicas'], 5);
    draft = setAt(draft, ['metadata', 'annotations', 'note'], 'x');
    draft = deleteAt(draft, ['metadata', 'labels', 'app.kubernetes.io/name']);
    const changes = diffChanges(deployment, draft);
    expect(changes.rows.get('/spec/replicas')).toEqual({ kind: 'changed', path: ['spec', 'replicas'] });
    expect(changes.rows.get('/metadata/annotations')?.kind).toBe('added');
    expect(changes.rows.get('/metadata/labels/app.kubernetes.io~1name')?.kind).toBe('removed');
    expect([...changes.touched].sort()).toEqual(['/metadata', '/metadata/labels', '/spec']);
  });

  it('treats a list whose length changed as one changed row', () => {
    const draft = deleteAt(deployment, ['spec', 'template', 'spec', 'containers', 0]);
    const changes = diffChanges(deployment, draft);
    expect([...changes.rows.keys()]).toEqual(['/spec/template/spec/containers']);
    expect(diffChanges(deployment, deployment).rows.size).toBe(0);
  });

  it('replays edits onto a newer snapshot', () => {
    const draft = setAt(setAt(deployment, ['spec', 'replicas'], 5), ['metadata', 'annotations', 'note'], 'x');
    const latest = setAt(setAt(deployment, ['metadata', 'resourceVersion'], '2'), ['spec', 'paused'], true);
    const rebased = rebaseEdits(deployment, draft, latest);
    expect(rebased.spec).toMatchObject({ replicas: 5, paused: true });
    expect(rebased.metadata).toMatchObject({ resourceVersion: '2', annotations: { note: 'x' } });
    const dropped = rebaseEdits(deployment, deleteAt(deployment, ['metadata', 'labels']), latest);
    expect(dropped.metadata).not.toHaveProperty('labels');
  });
});

describe('labels and summaries', () => {
  it('labels list items by a natural key and summarizes containers', () => {
    expect(itemLabel({ name: 'nginx' }, 0)).toBe('nginx');
    expect(itemLabel({ containerPort: 80 }, 3)).toBe('80');
    expect(itemLabel('plain', 2)).toBe('2');
    expect(hasNaturalKeys([{ name: 'a' }, { type: 'b' }])).toBe(true);
    expect(hasNaturalKeys([{ name: 'a' }, { foo: 'b' }])).toBe(false);
    expect(hasNaturalKeys([])).toBe(false);
    expect(collapsedPreview(deployment.spec.template.spec.containers)).toBe('nginx, sidecar');
    expect(collapsedPreview(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, …');
    expect(collapsedPreview(['sh', '-c', 'i=0; while true; do echo "kubus-e2e log line $i"; sleep 2; done'])).toBe('sh, -c, i=0; while true; do echo "kubus…');
    expect(collapsedPreview([{ x: 1 }])).toBe('');
    expect(collapsedPreview([])).toBe('');
    expect(collapsedPreview({ a: 1 })).toBe('');
    expect(collapsedPreview(null)).toBe('');
  });

  it('shortens type labels and unwraps hard-wrapped descriptions', () => {
    expect(compactType('integer (int32)')).toBe('int32');
    expect(compactType('string (date-time)')).toBe('date-time');
    expect(compactType('string (byte)')).toBe('base64');
    expect(compactType('array<object>')).toBe('object[]');
    expect(compactType('array<string (date-time)>')).toBe('date-time[]');
    expect(compactType('map<string>')).toBe('map<string>');
    expect(compactType('boolean')).toBe('bool');
    expect(compactType('integer')).toBe('int');
    expect(compactType('int-or-string')).toBe('int | string');
    expect(compactType('string | null')).toBe('string | null');
    expect(normalizeDescription('NodeSpec is the spec.\nIt is *flat* --\ncontainerlab vocabulary.\n\nSecond paragraph\nhere.\n')).toBe(
      'NodeSpec is the spec. It is *flat* -- containerlab vocabulary.\n\nSecond paragraph here.',
    );
  });

  it('opens shallow rows by default and keeps long lists closed', () => {
    expect(defaultExpanded({ a: 1 }, 0)).toBe(true);
    expect(defaultExpanded(Array.from({ length: 13 }, (_, i) => i), 0)).toBe(false);
    expect(defaultExpanded({ a: 1 }, 2)).toBe(true);
    expect(defaultExpanded({ a: 1 }, 3)).toBe(false);
    expect(defaultExpanded('scalar', 0)).toBe(false);
  });

  it('orders top-level groups metadata, spec, status, then the rest', () => {
    expect(manifestGroups({ kind: 'X', status: {}, data: {}, apiVersion: 'v1', spec: {}, metadata: {} }).map((g) => g.title)).toEqual(['Metadata', 'Spec', 'Status', 'data']);
    expect(splitApiVersion('apps/v1')).toEqual({ group: 'apps', version: 'v1' });
    expect(splitApiVersion('v1')).toEqual({ group: '', version: 'v1' });
    expect(splitApiVersion(undefined)).toEqual({ group: '', version: '' });
  });
});

describe('locking and filtering', () => {
  it('locks identity, status and redacted secret data', () => {
    expect(lockReason(['status', 'readyReplicas'])).toMatch(/controller/);
    expect(lockReason(['metadata', 'uid'])).toMatch(/Identity/);
    expect(lockReason(['kind'])).toMatch(/Identity/);
    expect(lockReason(['metadata', 'labels', 'app'])).toBeUndefined();
    expect(lockReason(['spec', 'replicas'])).toBeUndefined();
    expect(lockReason(['data', 'password'])).toBeUndefined();
    expect(lockReason(['data', 'password'], { secretRedacted: true })).toMatch(/Reveal/);
    expect(lockReason([])).toBeUndefined();
  });

  it('matches keys and scalar values and opens their ancestors', () => {
    const result = filterTree(deployment, [], 'sidecar');
    expect(result?.matches).toEqual(new Set(['/spec/template/spec/containers/1/name']));
    expect(result?.open).toEqual(new Set(['/spec', '/spec/template', '/spec/template/spec', '/spec/template/spec/containers', '/spec/template/spec/containers/1']));
    expect(filterTree(deployment, [], 'REPLICAS')?.matches).toEqual(new Set(['/spec/replicas', '/status/readyReplicas']));
    expect(filterTree(deployment, [], '   ')).toBeUndefined();
    expect(filterTree(deployment.spec.template.spec.containers, ['spec', 'template', 'spec', 'containers'], 'busybox')?.matches).toEqual(
      new Set(['/spec/template/spec/containers/1/image']),
    );
  });
});

describe('schema-typed editing', () => {
  const schema = {
    definitions: {
      Container: { type: 'object', properties: { name: { type: 'string', description: 'Container name' }, image: { type: 'string' } }, required: ['name'] },
      Spec: {
        type: 'object',
        properties: {
          replicas: { type: 'integer', description: 'Desired pods' },
          paused: { type: 'boolean' },
          strategy: { type: 'string', enum: ['Recreate', 'RollingUpdate'] },
          containers: { type: 'array', items: { $ref: '#/definitions/Container' } },
          nodeSelector: { type: 'object', additionalProperties: { type: 'string' } },
          port: { 'x-kubernetes-int-or-string': true },
          ratio: { type: 'number', default: 0.5 },
        },
      },
    },
    type: 'object',
    properties: { spec: { $ref: '#/definitions/Spec' } },
  };
  const defs = schemaDefinitions(schema);

  it('walks properties, items and map values', () => {
    expect(schemaAt(schema, defs, ['spec', 'replicas'])?.description).toBe('Desired pods');
    expect(schemaAt(schema, defs, ['spec', 'containers', 0, 'name'])?.description).toBe('Container name');
    expect(schemaAt(schema, defs, ['spec', 'nodeSelector', 'disktype'])?.type).toBe('string');
    expect(schemaAt(schema, defs, ['spec', 'unknown', 'deeper'])).toBeUndefined();
    expect(schemaAt(schema, defs, ['spec', 'replicas', 0])).toBeUndefined();
    expect(schemaAt(undefined, defs, ['spec'])).toBeUndefined();
    expect(schemaDefinitions(undefined)).toEqual({});
  });

  it('picks the editor from the schema, falling back to the value', () => {
    const at = (path: Array<string | number>) => schemaAt(schema, defs, path);
    expect(editorKindFor(at(['spec', 'replicas']), 2)).toBe('integer');
    expect(editorKindFor(at(['spec', 'paused']), undefined)).toBe('boolean');
    expect(editorKindFor(at(['spec', 'strategy']), 'Recreate')).toBe('enum');
    expect(editorKindFor(at(['spec', 'port']), 80)).toBe('int-or-string');
    expect(editorKindFor(at(['spec', 'ratio']), 0.5)).toBe('number');
    expect(editorKindFor(at(['spec', 'containers']), [])).toBe('yaml');
    expect(editorKindFor(undefined, true)).toBe('boolean');
    expect(editorKindFor(undefined, 3)).toBe('number');
    expect(editorKindFor(undefined, 'x')).toBe('string');
    expect(editorKindFor({ type: ['string', 'null'] }, null)).toBe('string');
  });

  it('parses typed input and rejects what does not fit', () => {
    expect(parseScalarInput(' 3 ', 'integer')).toEqual({ ok: true, value: 3 });
    expect(parseScalarInput('3.5', 'integer')).toMatchObject({ ok: false });
    expect(parseScalarInput('2.5', 'number')).toEqual({ ok: true, value: 2.5 });
    expect(parseScalarInput('', 'number')).toMatchObject({ ok: false });
    expect(parseScalarInput('true', 'boolean')).toEqual({ ok: true, value: true });
    expect(parseScalarInput('yes', 'boolean')).toMatchObject({ ok: false });
    expect(parseScalarInput('80', 'int-or-string')).toEqual({ ok: true, value: 80 });
    expect(parseScalarInput('http', 'int-or-string')).toEqual({ ok: true, value: 'http' });
    expect(parseScalarInput('a: 1', 'yaml')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseScalarInput('a: [', 'yaml')).toMatchObject({ ok: false });
    expect(parseScalarInput('plain', 'string')).toEqual({ ok: true, value: 'plain' });
    expect(parseYamlMapping('kind: X')).toEqual({ ok: true, value: { kind: 'X' } });
    expect(parseYamlMapping('- a')).toMatchObject({ ok: false, error: /mapping/ });
    expect(parseYamlMapping(':: [')).toMatchObject({ ok: false });
  });

  it('seeds new fields from their schema and suggests the missing ones', () => {
    const at = (path: Array<string | number>) => schemaAt(schema, defs, path);
    expect(emptyValueFor(at(['spec', 'containers']))).toEqual([]);
    expect(emptyValueFor(at(['spec', 'containers', 0]))).toEqual({});
    expect(emptyValueFor(at(['spec', 'paused']))).toBe(false);
    expect(emptyValueFor(at(['spec', 'replicas']))).toBe(0);
    expect(emptyValueFor(at(['spec', 'ratio']))).toBe(0.5);
    expect(emptyValueFor(at(['spec', 'strategy']))).toBe('Recreate');
    expect(emptyValueFor(undefined)).toBe('');
    const suggestions = suggestedKeys(at(['spec', 'containers', 0]), defs, ['image']);
    expect(suggestions.map((s) => s.name)).toEqual(['name']);
    expect(suggestions[0]).toMatchObject({ required: true, description: 'Container name' });
    expect(suggestedKeys(undefined, defs, [])).toEqual([]);
  });
});

describe('references', () => {
  it('detects kind/name objects and well-known name fields', () => {
    expect(referenceAt(['metadata', 'ownerReferences', 0], { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-abc' }, 'team-a')).toEqual({
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      name: 'web-abc',
      namespace: 'team-a',
    });
    expect(referenceAt(['spec', 'nodeName'], 'node-1', 'team-a')).toEqual({ kind: 'Node', name: 'node-1', namespace: 'team-a' });
    expect(referenceAt(['spec', 'containers', 0, 'envFrom', 0, 'configMapRef', 'name'], 'cfg', 'team-a')).toEqual({ kind: 'ConfigMap', name: 'cfg', namespace: 'team-a' });
    expect(referenceAt(['spec', 'imagePullSecrets', 0, 'name'], 'pull', 'team-a')).toEqual({ kind: 'Secret', name: 'pull', namespace: 'team-a' });
    expect(referenceAt(['spec', 'volumeName'], 'pv-1', 'team-a')).toEqual({ kind: 'PersistentVolume', name: 'pv-1' });
    expect(referenceAt(['spec', 'volumes', 0, 'name'], 'data', 'team-a')).toBeUndefined();
    expect(referenceAt(['spec', 'containers', 0, 'name'], 'nginx', 'team-a')).toBeUndefined();
    expect(referenceAt(['spec', 'template'], { kind: 'X' }, 'team-a')).toBeUndefined();
    expect(referenceAt(['spec', 'nodeName'], '', 'team-a')).toBeUndefined();
    expect(referenceAt(['spec', 0], 'x', undefined)).toBeUndefined();
  });
});
