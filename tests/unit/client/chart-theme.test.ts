import { describe, expect, it } from 'vitest';
import { formatAxisBytes, formatAxisCpu, formatAxisValue, metricColors, niceValueTicks, timeAxisTicks } from '../../../client/src/components/chart-theme';

const Mi = 1024 ** 2;
const Gi = 1024 ** 3;

describe('niceValueTicks', () => {
  it('rounds CPU up to 1-2-5 steps', () => {
    expect(niceValueTicks(280, 'cpu')).toEqual({ max: 300, tickInterval: [0, 100, 200, 300] });
    expect(niceValueTicks(3400, 'cpu')).toEqual({ max: 4000, tickInterval: [0, 1000, 2000, 3000, 4000] });
  });

  it('rounds bytes to power-of-two steps of a binary unit', () => {
    const { max, tickInterval } = niceValueTicks(1.8 * Gi, 'bytes');
    expect(max).toBe(2 * Gi);
    expect(tickInterval.map(formatAxisBytes)).toEqual(['0', '512Mi', '1Gi', '1.5Gi', '2Gi']);
  });

  it('never returns more than the allowed number of intervals', () => {
    for (const v of [1, 7, 99, 1234, 777 * Mi, 45 * Gi]) {
      const { tickInterval, max } = niceValueTicks(v, 'bytes');
      expect(tickInterval.length - 1).toBeLessThanOrEqual(4);
      expect(max).toBeGreaterThanOrEqual(v);
    }
  });

  it('still draws an axis without data', () => {
    expect(niceValueTicks(0, 'cpu').tickInterval).toEqual([0, 10]);
  });
});

describe('axis labels', () => {
  it('prints whole units without trailing zeros', () => {
    expect(formatAxisBytes(Gi)).toBe('1Gi');
    expect(formatAxisBytes(96 * Mi)).toBe('96Mi');
    expect(formatAxisCpu(250)).toBe('250m');
    expect(formatAxisCpu(1000)).toBe('1 core');
    expect(formatAxisCpu(1500)).toBe('1.5 cores');
    expect(formatAxisValue('rate', 512 * 1024)).toBe('512Ki/s');
  });
});

describe('timeAxisTicks', () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s);

  it('puts ticks on round minutes in 24 h time for a few minutes of data', () => {
    const { tickInterval, valueFormatter } = timeAxisTicks([at(18, 15, 25), at(18, 19, 40)]);
    expect(tickInterval.map((d) => d.getSeconds())).toEqual(tickInterval.map(() => 0));
    expect(valueFormatter(at(18, 16))).toMatch(/^18[:.]16$/);
  });

  it('only shows seconds for sub-minute steps', () => {
    const { tickInterval, valueFormatter } = timeAxisTicks([at(18, 15, 5), at(18, 16, 0)]);
    expect(tickInterval.length).toBeLessThanOrEqual(5);
    expect(valueFormatter(tickInterval[0]!)).toMatch(/^18[:.]15[:.]\d\d$/);
  });

  it('keeps long windows to a handful of ticks', () => {
    const { tickInterval } = timeAxisTicks([at(6, 0), at(18, 0)]);
    expect(tickInterval.length).toBeLessThanOrEqual(5);
    expect(tickInterval.every((d) => d.getMinutes() === 0)).toBe(true);
  });
});

describe('metricColors', () => {
  it('keeps memory off the health greens', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(metricColors(mode).memory).not.toMatch(/^#0+8300/i);
      expect(metricColors(mode).cpu).not.toBe(metricColors(mode).memory);
    }
  });
});
