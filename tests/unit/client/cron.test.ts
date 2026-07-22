import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cronHumanText, cronNextRun, cronNextRuns } from '../../../client/src/cron';

describe('cronNextRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:30:00Z')); // a Sunday
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes the next fire time in UTC by default', () => {
    expect(cronNextRun('0 12 * * *')?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(cronNextRun('*/15 * * * *')?.toISOString()).toBe('2026-03-01T10:45:00.000Z');
  });

  it('expands robfig macros', () => {
    expect(cronNextRun('@hourly')?.toISOString()).toBe('2026-03-01T11:00:00.000Z');
    expect(cronNextRun('@daily')?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(cronNextRun('@midnight')?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(cronNextRun('@weekly')?.toISOString()).toBe('2026-03-08T00:00:00.000Z');
    expect(cronNextRun('@monthly')?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(cronNextRun('@yearly')?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('treats ? as * like robfig', () => {
    expect(cronNextRun('0 12 * * ?')?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(cronNextRun('0 12 ? * *')?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });

  it('applies the spec.timeZone argument', () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    // New York is UTC-5 in January.
    expect(cronNextRun('0 12 * * *', 'America/New_York')?.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('lets a TZ= prefix override the timeZone argument', () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    expect(cronNextRun('TZ=America/New_York 0 12 * * *')?.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(cronNextRun('CRON_TZ=America/New_York 0 12 * * *')?.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(cronNextRun('TZ=UTC 0 12 * * *', 'America/New_York')?.toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });

  it('handles a TZ= prefix in front of a macro', () => {
    vi.setSystemTime(new Date('2026-01-15T00:30:00Z'));
    expect(cronNextRun('TZ=UTC @hourly')?.toISOString()).toBe('2026-01-15T01:00:00.000Z');
  });

  it('returns undefined for @every schedules (phase unknowable)', () => {
    expect(cronNextRun('@every 5m')).toBeUndefined();
  });

  it('rejects field counts robfig ParseStandard would reject', () => {
    expect(cronNextRun('0 0 * * * *')).toBeUndefined(); // seconds-first six fields
    expect(cronNextRun('* * *')).toBeUndefined();
    expect(cronNextRun('')).toBeUndefined();
  });

  it('returns undefined for unparseable expressions', () => {
    expect(cronNextRun('99 99 * * *')).toBeUndefined();
    expect(cronNextRun('not a cron at all!')).toBeUndefined();
  });
});

describe('cronNextRuns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the next N fire times in order', () => {
    expect(cronNextRuns('*/15 * * * *', undefined, 3).map((d) => d.toISOString())).toEqual([
      '2026-03-01T10:45:00.000Z',
      '2026-03-01T11:00:00.000Z',
      '2026-03-01T11:15:00.000Z',
    ]);
  });

  it('respects the timezone', () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    expect(cronNextRuns('0 12 * * *', 'America/New_York', 2).map((d) => d.toISOString())).toEqual([
      '2026-01-15T17:00:00.000Z',
      '2026-01-16T17:00:00.000Z',
    ]);
  });

  it('is empty for @every and unparseable schedules', () => {
    expect(cronNextRuns('@every 1h', undefined, 3)).toEqual([]);
    expect(cronNextRuns('nope', undefined, 3)).toEqual([]);
    expect(cronNextRuns('0 0 * * * *', undefined, 3)).toEqual([]);
  });
});

describe('cronHumanText', () => {
  it('describes plain five-field expressions in 24h time', () => {
    expect(cronHumanText('5 4 * * 0')).toBe('At 04:05, only on Sunday');
    expect(cronHumanText('*/10 * * * *')).toBe('Every 10 minutes');
  });

  it('describes macros via their expansion', () => {
    expect(cronHumanText('@hourly')).toBe('Every hour');
    expect(cronHumanText('@daily')).toBe('At 00:00');
  });

  it('describes ? like *', () => {
    expect(cronHumanText('0 12 * * ?')).toBe(cronHumanText('0 12 * * *'));
  });

  it('ignores a TZ= prefix for the text', () => {
    expect(cronHumanText('TZ=Europe/Berlin 0 12 * * *')).toBe(cronHumanText('0 12 * * *'));
  });

  it('renders @every schedules literally', () => {
    expect(cronHumanText('@every 90s')).toBe('Every 90s');
    expect(cronHumanText('@every')).toBeUndefined();
  });

  it('returns undefined when unparseable', () => {
    expect(cronHumanText('0 0 * * * *')).toBeUndefined();
    expect(cronHumanText('totally invalid')).toBeUndefined();
  });
});
