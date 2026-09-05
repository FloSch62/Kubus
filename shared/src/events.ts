import type { KubeObject } from './api-types.js';

export const SIGNAL_WINDOW_MS = 60 * 60 * 1000;

export interface EventShape extends KubeObject {
  type?: string;
  lastTimestamp?: string;
  eventTime?: string;
  firstTimestamp?: string;
  series?: { lastObservedTime?: string };
  involvedObject?: { uid?: string };
}

export function eventTimestamp(event: EventShape): string {
  return event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata.creationTimestamp ?? '';
}

export function isRecentWarning(event: EventShape, now: number, windowMs = SIGNAL_WINDOW_MS): boolean {
  const time = Date.parse(eventTimestamp(event));
  return event.type === 'Warning' && Number.isFinite(time) && now - time < windowMs;
}
