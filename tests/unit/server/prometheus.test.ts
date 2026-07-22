import { describe, expect, it } from 'vitest';
import { parsePrometheusText } from '../../../server/src/util/prometheus.js';

const fam = (...names: string[]) => new Set(names);

describe('parsePrometheusText', () => {
  it('parses a plain sample without labels', () => {
    expect(parsePrometheusText('node_memory_bytes 1073741824', fam('node_memory_bytes'))).toEqual([
      { name: 'node_memory_bytes', labels: {}, value: 1073741824 },
    ]);
  });

  it('parses counters with labels and skips HELP/TYPE/comment lines', () => {
    const text = [
      '# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.',
      '# TYPE node_cpu_seconds_total counter',
      'node_cpu_seconds_total{cpu="0",mode="idle"} 12345.6',
      'node_cpu_seconds_total{cpu="0",mode="user"} 78.9',
      '# just a comment',
      '# TYPE node_memory_bytes gauge',
      'node_memory_bytes 42',
    ].join('\n');
    expect(parsePrometheusText(text, fam('node_cpu_seconds_total', 'node_memory_bytes'))).toEqual([
      { name: 'node_cpu_seconds_total', labels: { cpu: '0', mode: 'idle' }, value: 12345.6 },
      { name: 'node_cpu_seconds_total', labels: { cpu: '0', mode: 'user' }, value: 78.9 },
      { name: 'node_memory_bytes', labels: {}, value: 42 },
    ]);
  });

  it('parses the exposition spellings of infinity', () => {
    const text = [
      'histogram_max_seconds{q="1"} +Inf',
      'histogram_min_seconds -Inf',
      'histogram_odd_seconds Inf',
      'histogram_go_seconds Infinity',
    ].join('\n');
    const families = fam(
      'histogram_max_seconds',
      'histogram_min_seconds',
      'histogram_odd_seconds',
      'histogram_go_seconds',
    );
    expect(parsePrometheusText(text, families)).toEqual([
      { name: 'histogram_max_seconds', labels: { q: '1' }, value: Infinity },
      { name: 'histogram_min_seconds', labels: {}, value: -Infinity },
      { name: 'histogram_odd_seconds', labels: {}, value: Infinity },
      { name: 'histogram_go_seconds', labels: {}, value: Infinity },
    ]);
  });

  it('only returns samples whose family was requested', () => {
    const text = ['wanted 1', 'unwanted 2', 'wanted{x="y"} 3'].join('\n');
    const samples = parsePrometheusText(text, fam('wanted'));
    expect(samples.map((s) => s.value)).toEqual([1, 3]);
  });

  it('returns nothing for an empty family set', () => {
    expect(parsePrometheusText('m 1', new Set())).toEqual([]);
  });

  it('parses an empty label set', () => {
    expect(parsePrometheusText('m{} 3', fam('m'))).toEqual([{ name: 'm', labels: {}, value: 3 }]);
  });

  it('unescapes \\" \\\\ and \\n in label values', () => {
    const text = 'm{msg="say \\"hi\\"",path="C:\\\\dir",multi="a\\nb"} 1';
    expect(parsePrometheusText(text, fam('m'))).toEqual([
      { name: 'm', labels: { msg: 'say "hi"', path: 'C:\\dir', multi: 'a\nb' }, value: 1 },
    ]);
  });

  it('keeps braces and commas inside quoted label values', () => {
    const text = 'm{selector="a{b},c"} 7';
    expect(parsePrometheusText(text, fam('m'))).toEqual([
      { name: 'm', labels: { selector: 'a{b},c' }, value: 7 },
    ]);
  });

  it('tolerates whitespace after label separators', () => {
    const text = 'm{a="1", b="2"} 5';
    expect(parsePrometheusText(text, fam('m'))).toEqual([
      { name: 'm', labels: { a: '1', b: '2' }, value: 5 },
    ]);
  });

  it('ignores an optional trailing timestamp', () => {
    expect(parsePrometheusText('m{a="1"} 42.5 1712000000000', fam('m'))).toEqual([
      { name: 'm', labels: { a: '1' }, value: 42.5 },
    ]);
  });

  it('parses scientific notation and negative values', () => {
    const text = ['m 1.5e3', 'm -7'].join('\n');
    expect(parsePrometheusText(text, fam('m')).map((s) => s.value)).toEqual([1500, -7]);
  });

  it('trims surrounding whitespace and skips blank lines', () => {
    const text = '\n  m{a="1"} 9  \n\n';
    expect(parsePrometheusText(text, fam('m'))).toEqual([{ name: 'm', labels: { a: '1' }, value: 9 }]);
  });

  it('skips malformed lines without dropping the rest', () => {
    const text = [
      'm 1',
      'm{a="unclosed 2',
      'm{a=unquoted} 3',
      'm{a="ok"}',
      'm not-a-number',
      'm',
      '{a="b"} 4',
      'm 5',
    ].join('\n');
    expect(parsePrometheusText(text, fam('m')).map((s) => s.value)).toEqual([1, 5]);
  });

  it('returns an empty list for empty input', () => {
    expect(parsePrometheusText('', fam('m'))).toEqual([]);
  });
});
