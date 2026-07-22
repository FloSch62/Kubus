import { describe, expect, it } from 'vitest';
import { countLabel, formatBps, formatBytes, formatCpu } from '../../../client/src/components/format';

describe('formatCpu', () => {
  it('shows millicores below one core', () => {
    expect(formatCpu(0)).toBe('0m');
    expect(formatCpu(1)).toBe('1m');
    expect(formatCpu(999)).toBe('999m');
    expect(formatCpu(0.5)).toBe('0.5m');
  });

  it('shows cores with two decimals from 1000m up', () => {
    expect(formatCpu(1000)).toBe('1.00 cores');
    expect(formatCpu(1234)).toBe('1.23 cores');
    expect(formatCpu(2500)).toBe('2.50 cores');
  });
});

describe('formatBytes', () => {
  it('shows raw bytes below 1Ki', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(1023)).toBe('1023B');
  });

  it('switches units at each binary boundary', () => {
    expect(formatBytes(1024)).toBe('1Ki');
    expect(formatBytes(2 ** 20 - 1)).toBe('1024Ki');
    expect(formatBytes(2 ** 20)).toBe('1Mi');
    expect(formatBytes(2 ** 30)).toBe('1.0Gi');
  });

  it('rounds Ki/Mi to whole numbers and Gi to one decimal', () => {
    expect(formatBytes(1536)).toBe('2Ki');
    expect(formatBytes(2.6 * 2 ** 20)).toBe('3Mi');
    expect(formatBytes(1.5 * 2 ** 30)).toBe('1.5Gi');
    expect(formatBytes(1.55 * 2 ** 30)).toBe('1.6Gi');
  });
});

describe('formatBps', () => {
  it('shows a floor marker for sub-byte rates', () => {
    expect(formatBps(0.4)).toBe('<1B/s');
    expect(formatBps(0.999)).toBe('<1B/s');
  });

  it('treats zero as zero, not sub-byte', () => {
    expect(formatBps(0)).toBe('0B/s');
  });

  it('rounds and reuses byte formatting', () => {
    expect(formatBps(1)).toBe('1B/s');
    expect(formatBps(1.4)).toBe('1B/s');
    expect(formatBps(2048)).toBe('2Ki/s');
    expect(formatBps(3 * 2 ** 20)).toBe('3Mi/s');
  });
});

describe('countLabel', () => {
  it('pluralizes naively', () => {
    expect(countLabel(0, 'item')).toBe('0 items');
    expect(countLabel(1, 'item')).toBe('1 item');
    expect(countLabel(2, 'item')).toBe('2 items');
    expect(countLabel(42, 'pod')).toBe('42 pods');
  });
});
