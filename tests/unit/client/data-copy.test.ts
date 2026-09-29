import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { envValue, serializeDataEntries } from '../../../client/src/components/detail/data-copy';
import type { DataEntry } from '../../../client/src/components/detail/data-editor';

let nextId = 1;
function entry(name: string, value: string, extra: Partial<DataEntry> = {}): DataEntry {
  return { id: nextId++, name, originalName: name, mode: 'text', value, deleted: false, ...extra };
}

describe('serializeDataEntries as KEY=value', () => {
  it('writes one line per text key, quoting only values that need it', () => {
    const out = serializeDataEntries(
      [
        entry('LOG_LEVEL', 'debug'),
        entry('URL', 'https://example.com/a?b=c'),
        entry('GREETING', 'hello world'),
        entry('MULTI', 'first\nsecond'),
        entry('QUOTED', 'say "hi" $HOME'),
        entry('EMPTY', ''),
      ],
      'env',
      false,
    );
    expect(out.text).toBe(
      ['LOG_LEVEL=debug', 'URL=https://example.com/a?b=c', "GREETING='hello world'", 'MULTI="first\\nsecond"', `QUOTED='say "hi" $HOME'`, 'EMPTY=', ''].join('\n'),
    );
    expect(out.count).toBe(6);
    expect(out.skipped).toEqual([]);
  });

  it('keeps $ literal: single quotes when possible, escaped inside double quotes otherwise', () => {
    // dotenv-expand and docker compose interpolate $ inside double quotes.
    expect(envValue('pa$word')).toBe("'pa$word'");
    expect(envValue('${HOME}/x #1')).toBe("'${HOME}/x #1'");
    expect(envValue('back\\slash')).toBe("'back\\slash'");
    // A single quote or a line break rules out single quotes.
    expect(envValue("it's $5")).toBe('"it\'s \\$5"');
    expect(envValue('a\n$b "c" \\d')).toBe('"a\\n\\$b \\"c\\" \\\\d"');
    expect(envValue('line\r\nend')).toBe('"line\\r\\nend"');
  });

  it('leaves out binary, removed and unnamed keys, reporting the binary ones', () => {
    const out = serializeDataEntries(
      [entry('keep', 'v'), entry('blob', 'AQID', { mode: 'binary' }), entry('gone', 'x', { deleted: true }), entry('', 'draft', { originalName: undefined })],
      'env',
      true,
    );
    expect(out.text).toBe('keep=v\n');
    expect(out.count).toBe(1);
    expect(out.skipped).toEqual(['blob']);
  });

  it('copies staged edits, not the stored values', () => {
    const out = serializeDataEntries([entry('mode', 'edited', { storedRaw: 'original' }), entry('renamed', 'x', { originalName: 'old' })], 'env', false);
    expect(out.text).toBe('mode=edited\nrenamed=x\n');
  });

  it('is empty when there is nothing to copy', () => {
    expect(serializeDataEntries([], 'env', false)).toEqual({ text: '', count: 0, skipped: [] });
  });
});

describe('serializeDataEntries as YAML', () => {
  it('uses data and binaryData for a ConfigMap', () => {
    const out = serializeDataEntries([entry('alpha', 'one'), entry('multi', 'first\nsecond\n'), entry('blob', 'AQ ID', { mode: 'binary' })], 'yaml', false);
    expect(load(out.text)).toEqual({ data: { alpha: 'one', multi: 'first\nsecond\n' }, binaryData: { blob: 'AQID' } });
    expect(out.text).toContain('multi: |');
    expect(out.count).toBe(3);
  });

  it('uses stringData for decoded Secret values and data for binary ones', () => {
    const out = serializeDataEntries([entry('password', 'hunter2'), entry('cert', '/w==', { mode: 'binary' })], 'yaml', true);
    expect(load(out.text)).toEqual({ stringData: { password: 'hunter2' }, data: { cert: '/w==' } });
  });

  it('keeps values YAML would otherwise retype as strings', () => {
    const out = serializeDataEntries([entry('port', '8080'), entry('flag', 'true'), entry('long', 'x'.repeat(300))], 'yaml', false);
    expect(load(out.text)).toEqual({ data: { port: '8080', flag: 'true', long: 'x'.repeat(300) } });
  });
});
