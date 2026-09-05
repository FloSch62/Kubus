import { describe, expect, it } from 'vitest';
import { eventTimestamp, isRecentWarning, SIGNAL_WINDOW_MS, type EventShape } from '@kubus/shared';

describe('recent warning events', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const at = (age: number) => new Date(now - age).toISOString();
  const event: EventShape = { metadata: { name: 'event', uid: 'event' }, type: 'Warning' };

  it('uses the latest series observation and timestamp fallbacks', () => {
    const timestamps = { series: { lastObservedTime: at(1) }, lastTimestamp: at(2), eventTime: at(3), firstTimestamp: at(4) };
    expect(eventTimestamp({ ...event, ...timestamps })).toBe(at(1));
    expect(eventTimestamp({ ...event, ...timestamps, series: undefined })).toBe(at(2));
    expect(eventTimestamp({ ...event, eventTime: at(3), firstTimestamp: at(4) })).toBe(at(3));
    expect(eventTimestamp({ ...event, firstTimestamp: at(4) })).toBe(at(4));
    expect(isRecentWarning({ ...event, metadata: { ...event.metadata, creationTimestamp: at(5) } }, now)).toBe(true);
  });

  it('excludes expired, undated, invalid and normal events', () => {
    expect(isRecentWarning({ ...event, lastTimestamp: at(SIGNAL_WINDOW_MS - 1) }, now)).toBe(true);
    expect(isRecentWarning({ ...event, lastTimestamp: at(SIGNAL_WINDOW_MS) }, now)).toBe(false);
    expect(isRecentWarning(event, now)).toBe(false);
    expect(isRecentWarning({ ...event, lastTimestamp: 'invalid' }, now)).toBe(false);
    expect(isRecentWarning({ ...event, type: 'Normal', lastTimestamp: at(1) }, now)).toBe(false);
  });
});
