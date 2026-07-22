import { describe, expect, it } from 'vitest';
import { cpuToMilli, memToBytes, parseQuantity } from '../../../server/src/kube/quantity.js';

describe('parseQuantity', () => {
  it('parses plain numbers as base units', () => {
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('128974848')).toBe(128974848);
    expect(parseQuantity('0.5')).toBe(0.5);
  });

  it('applies binary suffixes', () => {
    expect(parseQuantity('1Ki')).toBe(1024);
    expect(parseQuantity('129Mi')).toBe(129 * 2 ** 20);
    expect(parseQuantity('1Gi')).toBe(2 ** 30);
    expect(parseQuantity('2Ti')).toBe(2 * 2 ** 40);
  });

  it('applies decimal suffixes', () => {
    expect(parseQuantity('100m')).toBeCloseTo(0.1);
    expect(parseQuantity('250000000n')).toBeCloseTo(0.25);
    expect(parseQuantity('1500u')).toBeCloseTo(0.0015);
    expect(parseQuantity('123M')).toBe(123e6);
    expect(parseQuantity('1k')).toBe(1000);
  });

  it('supports scientific notation with suffixes', () => {
    expect(parseQuantity('1e3Ki')).toBe(1000 * 1024);
    expect(parseQuantity('1e2')).toBe(100);
  });

  it('handles whitespace and signs', () => {
    expect(parseQuantity(' 100m ')).toBeCloseTo(0.1);
    expect(parseQuantity('-1Ki')).toBe(-1024);
    expect(parseQuantity('+2')).toBe(2);
  });

  it('returns 0 for empty, undefined, or malformed input', () => {
    expect(parseQuantity(undefined)).toBe(0);
    expect(parseQuantity('')).toBe(0);
    expect(parseQuantity('abc')).toBe(0);
    expect(parseQuantity('12Xi')).toBe(0);
    expect(parseQuantity('Mi')).toBe(0);
  });
});

describe('cpuToMilli', () => {
  it('converts cores and sub-core quantities to millicores', () => {
    expect(cpuToMilli('2')).toBe(2000);
    expect(cpuToMilli('100m')).toBe(100);
    expect(cpuToMilli('250000000n')).toBe(250);
    expect(cpuToMilli('1500u')).toBe(2); // rounds 1.5m
    expect(cpuToMilli(undefined)).toBe(0);
  });
});

describe('memToBytes', () => {
  it('converts memory quantities to whole bytes', () => {
    expect(memToBytes('129Mi')).toBe(129 * 2 ** 20);
    expect(memToBytes('1.5Ki')).toBe(1536);
    expect(memToBytes('123M')).toBe(123000000);
    expect(memToBytes(undefined)).toBe(0);
  });
});
