import { describe, expect, it } from 'vitest';
import {
  detectLevel,
  markSegs,
  parseLine,
  stripAnsi,
  type Seg,
} from '../../../client/src/components/log-format';

const ESC = '\x1b';

function joined(segs: Seg[]): string {
  return segs.map((s) => s.text).join('');
}

describe('stripAnsi', () => {
  it('returns plain lines unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });

  it('removes SGR and other CSI sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain');
    expect(stripAnsi(`${ESC}[2K${ESC}[1;32mok${ESC}[m`)).toBe('ok');
  });
});

describe('parseLine (ANSI)', () => {
  it('applies base foreground colors', () => {
    expect(parseLine(`${ESC}[31mred${ESC}[0m plain`)).toEqual([
      { text: 'red', fg: '#f7768e' },
      { text: ' plain' },
    ]);
  });

  it('applies bright colors, bold and dim', () => {
    expect(parseLine(`${ESC}[1;91mloud${ESC}[22m${ESC}[2mquiet`)).toEqual([
      { text: 'loud', fg: '#ff8fa3', bold: true },
      { text: 'quiet', fg: '#ff8fa3', dim: true },
    ]);
  });

  it('applies background colors and clears them with 49', () => {
    expect(parseLine(`${ESC}[41mbad${ESC}[49m ok`)).toEqual([
      { text: 'bad', bg: '#f7768e' },
      { text: ' ok' },
    ]);
  });

  it('resolves 256-color palette indices', () => {
    // 1 → base palette, 196 → color cube corner, 232/255 → grayscale ramp
    expect(parseLine(`${ESC}[38;5;1mx`)).toEqual([{ text: 'x', fg: '#f7768e' }]);
    expect(parseLine(`${ESC}[38;5;196mx`)).toEqual([{ text: 'x', fg: 'rgb(255,0,0)' }]);
    expect(parseLine(`${ESC}[48;5;232mx`)).toEqual([{ text: 'x', bg: 'rgb(8,8,8)' }]);
    expect(parseLine(`${ESC}[38;5;255mx`)).toEqual([{ text: 'x', fg: 'rgb(238,238,238)' }]);
  });

  it('resolves 24-bit truecolor sequences', () => {
    expect(parseLine(`${ESC}[38;2;10;20;30mx`)).toEqual([{ text: 'x', fg: 'rgb(10,20,30)' }]);
    expect(parseLine(`${ESC}[48;2;1;2;3mx`)).toEqual([{ text: 'x', bg: 'rgb(1,2,3)' }]);
  });

  it('treats an empty SGR as a full reset', () => {
    expect(parseLine(`${ESC}[31ma${ESC}[mb`)).toEqual([{ text: 'a', fg: '#f7768e' }, { text: 'b' }]);
  });

  it('clears only the foreground with 39', () => {
    expect(parseLine(`${ESC}[31;41ma${ESC}[39mb`)).toEqual([
      { text: 'a', fg: '#f7768e', bg: '#f7768e' },
      { text: 'b', bg: '#f7768e' },
    ]);
  });

  it('drops non-SGR CSI sequences without styling', () => {
    expect(parseLine(`${ESC}[2Kfoo`)).toEqual([{ text: 'foo' }]);
  });

  it('yields one empty segment for a style-only line', () => {
    expect(parseLine(`${ESC}[31m`)).toEqual([{ text: '' }]);
  });
});

describe('parseLine (JSON)', () => {
  it('classifies keys, strings, numbers and booleans, preserving the text', () => {
    const line = '{"level":"info","count":3,"ok":true,"note":"hi there","gone":null}';
    const segs = parseLine(line);
    expect(joined(segs)).toBe(line);
    expect(segs).toContainEqual({ text: '"level"', cls: 'key' });
    expect(segs).toContainEqual({ text: '"info"', cls: 'str' });
    expect(segs).toContainEqual({ text: '"count"', cls: 'key' });
    expect(segs).toContainEqual({ text: '3', cls: 'num' });
    expect(segs).toContainEqual({ text: 'true', cls: 'bool' });
    expect(segs).toContainEqual({ text: 'null', cls: 'bool' });
    expect(segs).toContainEqual({ text: '"hi there"', cls: 'str' });
  });

  it('handles arrays and negative numbers', () => {
    const line = '[-1.5,2,"a"]';
    const segs = parseLine(line);
    expect(joined(segs)).toBe(line);
    expect(segs).toContainEqual({ text: '-1.5', cls: 'num' });
    expect(segs).toContainEqual({ text: '"a"', cls: 'str' });
  });

  it('keeps escaped quotes inside strings intact', () => {
    const line = '{"msg":"say \\"hi\\""}';
    const segs = parseLine(line);
    expect(joined(segs)).toBe(line);
    expect(segs).toContainEqual({ text: '"say \\"hi\\""', cls: 'str' });
  });

  it('treats a string before whitespace-separated colon as a key', () => {
    const segs = parseLine('{"a" : 1}');
    expect(segs).toContainEqual({ text: '"a"', cls: 'key' });
  });

  it('falls back to plain text for invalid JSON', () => {
    expect(parseLine('{not json}')).toEqual([{ text: '{not json}' }]);
  });

  it('skips JSON handling for very long lines', () => {
    const line = `{"a":"${'x'.repeat(16_400)}"}`;
    expect(parseLine(line)).toEqual([{ text: line }]);
  });
});

describe('parseLine (logfmt)', () => {
  it('classifies keys, values and numbers, preserving the text', () => {
    const line = 'level=info msg=hello count=3';
    const segs = parseLine(line);
    expect(joined(segs)).toBe(line);
    expect(segs).toContainEqual({ text: 'level', cls: 'key' });
    expect(segs).toContainEqual({ text: '=', cls: 'punct' });
    expect(segs).toContainEqual({ text: 'info', cls: 'str' });
    expect(segs).toContainEqual({ text: '3', cls: 'num' });
  });

  it('keeps quoted values as a single segment', () => {
    const segs = parseLine('msg="hello world" level=warn');
    expect(segs).toContainEqual({ text: '"hello world"', cls: 'str' });
  });

  it('marks decimal and negative values as numbers', () => {
    const segs = parseLine('x=-1.5 y=2');
    expect(segs).toContainEqual({ text: '-1.5', cls: 'num' });
    expect(segs).toContainEqual({ text: '2', cls: 'num' });
  });

  it('keeps interstitial text between pairs', () => {
    const line = 'ts=123 something level=warn';
    const segs = parseLine(line);
    expect(joined(segs)).toBe(line);
    expect(segs).toContainEqual({ text: ' something ' });
  });

  it('requires at least two pairs', () => {
    expect(parseLine('foo=bar')).toEqual([{ text: 'foo=bar' }]);
  });

  it('leaves plain lines untouched', () => {
    expect(parseLine('just a message')).toEqual([{ text: 'just a message' }]);
    expect(parseLine('')).toEqual([{ text: '' }]);
  });
});

describe('detectLevel', () => {
  it('reads klog prefixes', () => {
    expect(detectLevel('I0722 10:00:00.000000       1 controller.go:42] synced')).toBe('info');
    expect(detectLevel('W0722 10:00:00.000000       1 x.go:1] slow')).toBe('warn');
    expect(detectLevel('E0722 10:00:00.000000       1 x.go:1] boom')).toBe('error');
    expect(detectLevel('F0722 10:00:00.000000       1 x.go:1] dead')).toBe('error');
  });

  it('reads structured JSON and logfmt levels', () => {
    expect(detectLevel('{"level":"error","msg":"x"}')).toBe('error');
    expect(detectLevel('{"severity":"WARNING","msg":"x"}')).toBe('warn');
    expect(detectLevel('level=warn msg=x')).toBe('warn');
    expect(detectLevel("lvl='dbg' msg=x")).toBe('debug');
  });

  it('reads bare and bracketed level words near the start', () => {
    expect(detectLevel('[ERROR] failed to connect')).toBe('error');
    expect(detectLevel('WARN: disk almost full')).toBe('warn');
    expect(detectLevel('2026-07-22 INFO starting up')).toBe('info');
    expect(detectLevel('An error occurred')).toBe('error');
  });

  it('maps aliases onto the five levels', () => {
    expect(detectLevel('FATAL: out of memory')).toBe('error');
    expect(detectLevel('panic: nil pointer')).toBe('error');
    expect(detectLevel('NOTICE: rotated logs')).toBe('info');
    expect(detectLevel('wrn something')).toBe('warn');
    expect(detectLevel('TRACE enter fn')).toBe('trace');
  });

  it('avoids substring false positives', () => {
    expect(detectLevel('terror strikes at midnight')).toBeUndefined();
    expect(detectLevel('information kiosk opened')).toBeUndefined();
    expect(detectLevel('hello world')).toBeUndefined();
  });

  it('only scans the head of the line', () => {
    expect(detectLevel(`${'x'.repeat(250)} error late`)).toBeUndefined();
  });

  it('returns undefined for unknown structured level words', () => {
    expect(detectLevel('level=verbose msg=x')).toBeUndefined();
  });
});

describe('markSegs', () => {
  it('returns the input array untouched for an empty query', () => {
    const segs: Seg[] = [{ text: 'abc' }];
    expect(markSegs(segs, '')).toBe(segs);
  });

  it('splits matching runs out with mark=true', () => {
    expect(markSegs([{ text: 'say hello twice hello' }], 'hello')).toEqual([
      { text: 'say ' },
      { text: 'hello', mark: true },
      { text: ' twice ' },
      { text: 'hello', mark: true },
    ]);
  });

  it('matches case-insensitively while preserving original text', () => {
    expect(markSegs([{ text: 'Hello World' }], 'hello')).toEqual([
      { text: 'Hello', mark: true },
      { text: ' World' },
    ]);
  });

  it('carries segment styling onto the split pieces', () => {
    expect(markSegs([{ text: 'Error: bad', fg: '#f00', bold: true }], 'bad')).toEqual([
      { text: 'Error: ', fg: '#f00', bold: true },
      { text: 'bad', fg: '#f00', bold: true, mark: true },
    ]);
  });

  it('leaves non-matching segments unmarked', () => {
    expect(markSegs([{ text: 'abc' }, { text: 'def' }], 'zz')).toEqual([{ text: 'abc' }, { text: 'def' }]);
  });

  it('does not match across segment boundaries', () => {
    expect(markSegs([{ text: 'ab' }, { text: 'cd' }], 'bc')).toEqual([{ text: 'ab' }, { text: 'cd' }]);
  });
});
