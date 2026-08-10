import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchClient, type ContextWatchIssues } from '../../../client/src/api/ws/watch-client';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: string[] = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('watch context issues', () => {
  it('aggregates subscription failures by context and clears them when live', () => {
    const snapshots: ContextWatchIssues[] = [];
    const stopIssues = watchClient.onContextIssues((issues) => snapshots.push(issues));
    const stopWatch = watchClient.subscribe(
      { ctx: 'constructor', group: 'core', version: 'v1', plural: 'pods' },
      { onSnapshot: vi.fn(), onEvents: vi.fn(), onStatus: vi.fn() },
    );
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const subscription = JSON.parse(socket.sent[0]!) as { id: string };

    socket.receive({ op: 'status', id: subscription.id, state: 'reconnecting', message: 'connection lost' });
    expect(snapshots.at(-1)).toEqual(new Map([['constructor', { state: 'reconnecting', message: 'connection lost' }]]));

    socket.receive({ op: 'status', id: subscription.id, state: 'live' });
    expect(snapshots.at(-1)).toEqual(new Map());

    stopIssues();
    stopWatch();
    vi.advanceTimersByTime(30_000);
  });
});
