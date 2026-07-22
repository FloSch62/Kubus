import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  REDACTED,
  b64ByteLength,
  b64ToBytes,
  b64ToText,
  buildManifest,
  bytesToB64,
  entriesFromObject,
  entryDirty,
  isValidB64,
  maskSecretValues,
  textToB64,
  validateEntries,
  type DataEntry,
} from '../../../client/src/components/detail/data-editor';

describe('base64 codec', () => {
  it('encodes text to base64', () => {
    expect(textToB64('hello')).toBe('aGVsbG8=');
    expect(textToB64('')).toBe('');
  });

  it('round-trips unicode through textToB64/b64ToText', () => {
    const original = 'héllo wörld — 日本語 🚀';
    expect(b64ToText(textToB64(original))).toBe(original);
  });

  it('round-trips arbitrary bytes through bytesToB64/b64ToBytes', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
  });

  it('validates base64', () => {
    expect(isValidB64('aGVsbG8=')).toBe(true);
    expect(isValidB64('')).toBe(true);
    expect(isValidB64('not base64 at all!')).toBe(false);
    expect(isValidB64('aGVsbG8')).toBe(true); // atob forgives missing padding
    expect(isValidB64('a')).toBe(false); // length ≡ 1 mod 4 is never valid
  });

  it('computes byte length without decoding', () => {
    expect(b64ByteLength('')).toBe(0);
    expect(b64ByteLength('aGVsbG8=')).toBe(5);
    expect(b64ByteLength(textToB64('a'))).toBe(1); // YQ== double padding
    expect(b64ByteLength(textToB64('ab'))).toBe(2);
    expect(b64ByteLength(textToB64('abc'))).toBe(3);
    expect(b64ByteLength('aGVs\nbG8=\n')).toBe(5); // whitespace ignored
  });

  it('b64ToText refuses invalid UTF-8', () => {
    expect(b64ToText(bytesToB64(new Uint8Array([0xff, 0xfe])))).toBeUndefined();
  });

  it('b64ToText refuses control characters but allows tab/newline/CR', () => {
    expect(b64ToText(textToB64('a\x00b'))).toBeUndefined();
    expect(b64ToText(textToB64('a\x1bb'))).toBeUndefined();
    expect(b64ToText(textToB64('a\x7fb'))).toBeUndefined();
    expect(b64ToText(textToB64('a\tb\r\nc'))).toBe('a\tb\r\nc');
  });
});

function entry(overrides: Partial<DataEntry>): DataEntry {
  return { id: 1, name: 'k', mode: 'text', value: '', deleted: false, ...overrides };
}

describe('entriesFromObject', () => {
  it('maps ConfigMap data to text entries and binaryData to binary entries', () => {
    const cm: KubeObject = {
      metadata: { name: 'cm', uid: 'u1' },
      data: { 'app.conf': 'listen 80' },
      binaryData: { blob: 'AAEC' },
    };
    expect(entriesFromObject(cm, false, 10)).toEqual([
      { id: 10, name: 'app.conf', originalName: 'app.conf', storedRaw: 'listen 80', storedField: 'data', mode: 'text', value: 'listen 80', deleted: false },
      { id: 11, name: 'blob', originalName: 'blob', storedRaw: 'AAEC', storedField: 'binaryData', mode: 'binary', value: 'AAEC', deleted: false },
    ]);
  });

  it('decodes Secret values that are editable text, keeps binary payloads as base64', () => {
    const binary = bytesToB64(new Uint8Array([0x00, 0x01, 0x02]));
    const secret: KubeObject = {
      metadata: { name: 's', uid: 'u2' },
      data: { user: textToB64('admin'), cert: binary },
    };
    const entries = entriesFromObject(secret, true, 0);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'user', mode: 'text', value: 'admin', storedRaw: textToB64('admin'), storedField: 'data' });
    expect(entries[1]).toMatchObject({ name: 'cert', mode: 'binary', value: binary, storedField: 'data' });
  });

  it('skips non-string values and handles missing fields', () => {
    const obj: KubeObject = { metadata: { name: 'x', uid: 'u3' }, data: { ok: 'v', bad: 42 as unknown as string } };
    expect(entriesFromObject(obj, false, 0).map((e) => e.name)).toEqual(['ok']);
    expect(entriesFromObject({ metadata: { name: 'y', uid: 'u4' } }, false, 0)).toEqual([]);
  });
});

describe('entryDirty', () => {
  const clean = entry({ name: 'a', originalName: 'a', storedRaw: 'v', storedField: 'data', value: 'v' });

  it('is clean for an unchanged entry', () => {
    expect(entryDirty(clean, false)).toBe(false);
  });

  it('is dirty for new, renamed, deleted or value-changed entries', () => {
    expect(entryDirty(entry({ name: 'new' }), false)).toBe(true);
    expect(entryDirty({ ...clean, name: 'renamed' }, false)).toBe(true);
    expect(entryDirty({ ...clean, deleted: true }, false)).toBe(true);
    expect(entryDirty({ ...clean, value: 'changed' }, false)).toBe(true);
  });

  it('is dirty when a ConfigMap entry switches field via its mode', () => {
    expect(entryDirty({ ...clean, mode: 'binary' }, false)).toBe(true);
  });

  it('compares Secret text values in manifest encoding', () => {
    const secret = entry({ name: 's', originalName: 's', storedRaw: textToB64('pw'), storedField: 'data', value: 'pw' });
    expect(entryDirty(secret, true)).toBe(false);
    expect(entryDirty({ ...secret, value: 'pw2' }, true)).toBe(true);
  });

  it('ignores whitespace in binary values', () => {
    const bin = entry({ name: 'b', originalName: 'b', storedRaw: 'AAEC', storedField: 'binaryData', mode: 'binary', value: 'AA EC\n' });
    expect(entryDirty(bin, false)).toBe(false);
  });
});

describe('validateEntries', () => {
  it('accepts valid entries', () => {
    expect(validateEntries([entry({ id: 1, name: 'app.conf_1-A' })])).toEqual([]);
  });

  it('flags empty, overlong and invalid key names', () => {
    expect(validateEntries([entry({ id: 1, name: '' })])).toEqual([{ id: 1, target: 'name', message: 'Key name is required' }]);
    expect(validateEntries([entry({ id: 2, name: 'x'.repeat(254) })])[0]).toMatchObject({ target: 'name', message: 'Key name must be at most 253 characters' });
    expect(validateEntries([entry({ id: 3, name: 'no spaces' })])[0]).toMatchObject({ target: 'name' });
  });

  it('flags every duplicate of a key name', () => {
    const problems = validateEntries([entry({ id: 1, name: 'dup' }), entry({ id: 2, name: 'dup' })]);
    expect(problems).toEqual([
      { id: 1, target: 'name', message: 'Duplicate key name' },
      { id: 2, target: 'name', message: 'Duplicate key name' },
    ]);
  });

  it('flags invalid base64 in binary mode, ignoring whitespace', () => {
    expect(validateEntries([entry({ id: 1, name: 'b', mode: 'binary', value: '!!!' })])).toEqual([
      { id: 1, target: 'value', message: 'Not valid base64' },
    ]);
    expect(validateEntries([entry({ id: 2, name: 'b', mode: 'binary', value: 'AA EC\n' })])).toEqual([]);
  });

  it('skips deleted entries entirely', () => {
    expect(validateEntries([entry({ id: 1, name: '', deleted: true })])).toEqual([]);
  });
});

describe('buildManifest', () => {
  const latest = (): KubeObject => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'cm', uid: 'u1', managedFields: [{ manager: 'kubectl' }] } as unknown as KubeObject['metadata'],
    data: { a: 'server-a', b: 'server-b' },
  });

  it('strips managedFields and stringData', () => {
    const obj = { ...latest(), stringData: { a: 'x' } };
    const manifest = buildManifest(obj, [], false);
    expect((manifest.metadata as unknown as Record<string, unknown>).managedFields).toBeUndefined();
    expect(manifest.stringData).toBeUndefined();
  });

  it('applies edits and keeps untouched keys from the latest object', () => {
    const entries = [entry({ name: 'a', originalName: 'a', storedRaw: 'server-a', storedField: 'data', value: 'edited-a' })];
    expect(buildManifest(latest(), entries, false).data).toEqual({ a: 'edited-a', b: 'server-b' });
  });

  it('mirrors a concurrent edit for entries the draft did not change', () => {
    // Draft was loaded when a='old'; another client wrote 'server-a' since.
    const entries = [entry({ name: 'a', originalName: 'a', storedRaw: 'old', storedField: 'data', value: 'old' })];
    expect(buildManifest(latest(), entries, false).data).toEqual({ a: 'server-a', b: 'server-b' });
  });

  it('drops deleted keys and removes an emptied field', () => {
    const entries = [
      entry({ id: 1, name: 'a', originalName: 'a', storedRaw: 'server-a', storedField: 'data', deleted: true }),
      entry({ id: 2, name: 'b', originalName: 'b', storedRaw: 'server-b', storedField: 'data', deleted: true }),
    ];
    const manifest = buildManifest(latest(), entries, false);
    expect(manifest.data).toBeUndefined();
    expect('data' in manifest).toBe(false);
  });

  it('renames a key', () => {
    const entries = [entry({ name: 'a2', originalName: 'a', storedRaw: 'server-a', storedField: 'data', value: 'server-a' })];
    expect(buildManifest(latest(), entries, false).data).toEqual({ a2: 'server-a', b: 'server-b' });
  });

  it('moves a ConfigMap key between data and binaryData when the mode changes', () => {
    const entries = [entry({ name: 'a', originalName: 'a', storedRaw: 'server-a', storedField: 'data', mode: 'binary', value: 'AAEC' })];
    const manifest = buildManifest(latest(), entries, false);
    expect(manifest.data).toEqual({ b: 'server-b' });
    expect(manifest.binaryData).toEqual({ a: 'AAEC' });
  });

  it('encodes Secret text edits as base64', () => {
    const secret: KubeObject = { metadata: { name: 's', uid: 'u' }, data: { pw: textToB64('old') } };
    const entries = [entry({ name: 'pw', originalName: 'pw', storedRaw: textToB64('old'), storedField: 'data', value: 'new' })];
    expect(buildManifest(secret, entries, true).data).toEqual({ pw: textToB64('new') });
  });

  it('adds new keys', () => {
    const entries = [entry({ name: 'c', value: 'new-c' })];
    expect(buildManifest(latest(), entries, false).data).toEqual({ a: 'server-a', b: 'server-b', c: 'new-c' });
  });
});

describe('maskSecretValues', () => {
  it('masks keys the shown predicate rejects, in both fields', () => {
    const obj: KubeObject = {
      metadata: { name: 's', uid: 'u' },
      data: { visible: 'dg==', hidden: 'aA==' },
      binaryData: { blob: 'AAEC' },
    };
    const masked = maskSecretValues(obj, (name) => name === 'visible');
    expect(masked.data).toEqual({ visible: 'dg==', hidden: REDACTED });
    expect(masked.binaryData).toEqual({ blob: REDACTED });
    // Original untouched.
    expect(obj.data).toEqual({ visible: 'dg==', hidden: 'aA==' });
  });

  it('handles objects without data fields', () => {
    const obj: KubeObject = { metadata: { name: 's', uid: 'u' } };
    expect(maskSecretValues(obj, () => false)).toEqual(obj);
  });
});
