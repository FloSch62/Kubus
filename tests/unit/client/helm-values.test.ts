import { describe, expect, it } from 'vitest';
import {
  canonicalValuesYaml,
  parseValues,
  rebaseValuesText,
  unknownValuePaths,
  valuesOverrides,
} from '../../../client/src/components/helm-values';

describe('canonicalValuesYaml', () => {
  it('sorts keys recursively for stable comparison', () => {
    expect(canonicalValuesYaml({ b: 1, a: { d: 2, c: 3 } })).toBe('a:\n  c: 3\n  d: 2\nb: 1\n');
  });

  it('produces identical output for semantically equal objects', () => {
    expect(canonicalValuesYaml({ x: 1, y: 2 })).toBe(canonicalValuesYaml({ y: 2, x: 1 }));
  });
});

describe('parseValues', () => {
  it('parses a mapping', () => {
    expect(parseValues('replicas: 3\nimage:\n  tag: v1\n')).toEqual({ values: { replicas: 3, image: { tag: 'v1' } } });
  });

  it('treats empty, whitespace-only and comment-only input as no overrides', () => {
    expect(parseValues('')).toEqual({ values: {} });
    expect(parseValues('   \n\n')).toEqual({ values: {} });
    expect(parseValues('# just a comment\n')).toEqual({ values: {} });
  });

  it('rejects multi-document input', () => {
    expect(parseValues('a: 1\n---\nb: 2\n').error).toBe('values must be a single YAML document');
  });

  it('rejects non-mapping documents', () => {
    expect(parseValues('- a\n- b\n').error).toBe('values must be a YAML mapping');
    expect(parseValues('just a string\n').error).toBe('values must be a YAML mapping');
  });

  it('reports YAML syntax errors', () => {
    const { error } = parseValues('a: [1, 2\n');
    expect(error).toMatch(/^values YAML: /);
  });
});

describe('valuesOverrides', () => {
  it('keeps only values that differ from defaults', () => {
    const defaults = { replicas: 1, image: { repo: 'nginx', tag: '1.0' }, enabled: true };
    const edited = { replicas: 5, image: { repo: 'nginx', tag: '2.0' }, enabled: true };
    expect(valuesOverrides(defaults, edited)).toEqual({ replicas: 5, image: { tag: '2.0' } });
  });

  it('returns {} when nothing changed', () => {
    const defaults = { a: 1, nested: { b: [1, 2], c: null } };
    expect(valuesOverrides(defaults, { a: 1, nested: { b: [1, 2], c: null } })).toEqual({});
  });

  it('keeps keys absent from defaults', () => {
    expect(valuesOverrides({}, { extra: 'x', nul: null })).toEqual({ extra: 'x', nul: null });
  });

  it('compares arrays deeply and replaces them wholesale', () => {
    expect(valuesOverrides({ list: [1, 2, 3] }, { list: [1, 2, 3] })).toEqual({});
    expect(valuesOverrides({ list: [1, 2, 3] }, { list: [1, 2] })).toEqual({ list: [1, 2] });
  });

  it('compares Dates by timestamp instead of as plain objects', () => {
    expect(valuesOverrides({ d: new Date(1000) }, { d: new Date(1000) })).toEqual({});
    expect(valuesOverrides({ d: new Date(1000) }, { d: new Date(2000) })).toEqual({ d: new Date(2000) });
  });

  it('keeps a scalar override replacing an object default', () => {
    expect(valuesOverrides({ persistence: { enabled: true } }, { persistence: null })).toEqual({ persistence: null });
  });
});

describe('unknownValuePaths', () => {
  it('reports paths absent from the defaults, with dotted nesting', () => {
    const values = { foo: 1, nested: { known: 5, extra: 2 } };
    const defaults = { nested: { known: 0 }, other: 1 };
    expect(unknownValuePaths(values, defaults)).toEqual(['foo', 'nested.extra']);
  });

  it('accepts anything under an empty-map default (arbitrary map hole)', () => {
    expect(unknownValuePaths({ free: { anything: 1 } }, { free: {} })).toEqual([]);
  });

  it('is empty when every path is known', () => {
    expect(unknownValuePaths({ a: 1, b: { c: 2 } }, { a: 0, b: { c: 0, d: 0 } })).toEqual([]);
  });
});

describe('rebaseValuesText', () => {
  const oldDefaults = 'replicas: 1\nimage:\n  repo: nginx\n  tag: "1.0"\nremoved: true\n';
  const newDefaults = '# chart comment\nreplicas: 2\nimage:\n  repo: nginx\n  tag: "2.0"\nadded: hi\n';

  it('returns the new defaults verbatim (comments intact) when the user made no edits', () => {
    expect(rebaseValuesText(oldDefaults, oldDefaults, newDefaults)).toBe(newDefaults);
  });

  it('preserves a user override over the new chart default', () => {
    const edited = 'replicas: 5\nimage:\n  repo: nginx\n  tag: "1.0"\nremoved: true\n';
    const out = rebaseValuesText(edited, oldDefaults, newDefaults)!;
    expect(parseValues(out).values).toEqual({
      replicas: 5, // user's edit wins over the new default 2
      image: { repo: 'nginx', tag: '2.0' }, // untouched default follows the new chart
      added: 'hi', // new defaults appear
      // 'removed' is gone: the user never overrode it
    });
  });

  it('keeps a user edit even when the new chart changed the same default', () => {
    const edited = 'replicas: 1\nimage:\n  repo: nginx\n  tag: custom\nremoved: true\n';
    const out = rebaseValuesText(edited, oldDefaults, newDefaults)!;
    expect(parseValues(out).values).toMatchObject({ image: { repo: 'nginx', tag: 'custom' } });
  });

  it('carries an override of a key the new chart dropped', () => {
    const edited = 'replicas: 1\nimage:\n  repo: nginx\n  tag: "1.0"\nremoved: false\n';
    const out = rebaseValuesText(edited, oldDefaults, newDefaults)!;
    expect(parseValues(out).values).toMatchObject({ removed: false });
  });

  it('keeps an explicit null as a drop-this-default marker', () => {
    const edited = 'replicas: 1\nimage: null\nremoved: true\n';
    const out = rebaseValuesText(edited, oldDefaults, newDefaults)!;
    expect(parseValues(out).values).toMatchObject({ image: null });
  });

  it('rebases user-added keys unknown to either chart', () => {
    const edited = `${oldDefaults}custom:\n  mine: 1\n`;
    const out = rebaseValuesText(edited, oldDefaults, newDefaults)!;
    expect(parseValues(out).values).toMatchObject({ custom: { mine: 1 }, replicas: 2 });
  });

  it('returns undefined when any of the three texts does not parse', () => {
    expect(rebaseValuesText('a: [1,\n', oldDefaults, newDefaults)).toBeUndefined();
    expect(rebaseValuesText(oldDefaults, '- not a mapping\n', newDefaults)).toBeUndefined();
    expect(rebaseValuesText(oldDefaults, oldDefaults, 'x: {bad\n')).toBeUndefined();
  });
});
