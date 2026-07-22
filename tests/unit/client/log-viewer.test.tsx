/* oxlint-disable typescript/unbound-method -- browser APIs are replaced with mocks in this test. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_SOCKET_COMPLETE_CODE, LOG_SOCKET_NO_STREAMS_CODE } from '@kubus/shared';
import { LogViewer } from '../../../client/src/components/LogViewer';
import { useDockStore, type LogsTab } from '../../../client/src/state/dock';
import { useLogPrefsStore } from '../../../client/src/state/log-prefs';
import { useUiPrefsStore } from '../../../client/src/state/prefs';

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));
vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: clipboard.copy }));

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn((code = 1000) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  serverClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

function logsTab(overrides: Partial<LogsTab> = {}): LogsTab {
  return {
    kind: 'logs',
    id: 'logs-1',
    title: 'logs: deployment/web',
    ctx: 'dev/x',
    namespace: 'team-a',
    pods: ['web-a', 'web-b'],
    sources: [
      { pod: 'web-a', containers: ['app', 'sidecar'] },
      { pod: 'web-b', containers: ['app'] },
    ],
    target: { kind: 'Deployment', name: 'web' },
    follow: true,
    ...overrides,
  };
}

function socket(): MockWebSocket {
  return MockWebSocket.instances.at(-1)!;
}

function flushLines(): void {
  void act(() => vi.advanceTimersByTime(121));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  clipboard.copy.mockClear();
  useLogPrefsStore.setState({ wrap: false, tsMode: 'off', highlight: true, enabledContainersByWorkload: {} });
  useUiPrefsStore.setState({ monoFontSize: 12, defaultTailLines: 500 });
  useDockStore.setState({ maximized: false, tabs: [], open: false });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:logs') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LogViewer', () => {
  it('streams, formats, filters, finds, marks, copies, downloads, and clears lines', () => {
    const view = render(<LogViewer tab={logsTab()} />);
    expect(socket().url).toContain('/ws/logs?');
    expect(socket().url).toContain('ctx=dev%2Fx');
    expect(socket().url).toContain('pods=web-a%2Cweb-b');
    expect(socket().url).toContain('tailLines=500');

    act(() => {
      socket().open();
      socket().message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T11:59:59.123Z', line: '\u001b[31mERROR\u001b[0m request failed code=500' });
      socket().message({ op: 'line', pod: 'web-a', container: 'sidecar', ts: '2026-07-22T11:59:59.124Z', line: '{"level":"warn","message":"slow request","ms":42}' });
      socket().message({ op: 'line', pod: 'web-b', container: 'app', line: 'INFO ready=true count=2' });
      socket().message({ op: 'line', pod: 'web-b', container: 'app', line: 'plain heartbeat' });
      socket().message({ op: 'pod-status', pod: 'web-b', container: 'app', state: 'error', message: 'stream denied' });
      socket().message({ op: 'pod-status', pod: 'web-b', container: 'app', state: 'running' });
      socket().message('{not-json');
    });
    flushLines();

    expect(screen.getByText(/request failed code=500/)).toBeInTheDocument();
    expect(screen.getByText(/slow request/)).toBeInTheDocument();
    expect(screen.getByText(/stream denied/)).toBeInTheDocument();
    expect(screen.getByLabelText('Filter error logs')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter warn logs')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter info logs')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Filter error logs'));
    expect(screen.getByText(/1\/5 lines/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Filter error logs'));

    const filter = screen.getByPlaceholderText('Filter (regex)…');
    fireEvent.change(filter, { target: { value: 'web-b|heartbeat' } });
    expect(screen.getByText(/heartbeat/)).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: '[' } });
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter).toHaveValue('');
    fireEvent.keyDown(filter, { key: 'Escape' });

    const find = screen.getByPlaceholderText('Find…');
    fireEvent.change(find, { target: { value: 'request' } });
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    fireEvent.keyDown(find, { key: 'Enter' });
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(find, { key: 'Escape' });
    expect(find).toHaveValue('');
    fireEvent.keyDown(find, { key: 'Escape' });
    fireEvent.keyDown(view.container.firstElementChild!, { key: 'f', ctrlKey: true });

    fireEvent.click(screen.getByLabelText('Add visual log marker'));
    fireEvent.keyDown(view.container.firstElementChild!, { key: ' ' });
    expect(screen.getAllByText(/Marker ·/).length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add visual log marker' }), { key: ' ' });

    fireEvent.click(screen.getByLabelText('Disable syntax highlighting'));
    fireEvent.click(screen.getByLabelText('Wrap long lines'));
    fireEvent.click(screen.getByLabelText('Timestamps: off'));
    fireEvent.click(screen.getByLabelText('Resume auto-scroll'));
    fireEvent.click(screen.getByLabelText('Pause auto-scroll'));
    expect(useLogPrefsStore.getState()).toMatchObject({ wrap: true, tsMode: 'local', highlight: false });

    const output = screen.getByLabelText('Log output');
    Object.defineProperties(output, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(output);

    const toolbarButtons = screen.getAllByRole('button');
    const copyButton = toolbarButtons.find((button) => button.querySelector('[data-testid="ContentCopyIcon"]'))!;
    const downloadButton = toolbarButtons.find((button) => button.querySelector('[data-testid="DownloadIcon"]'))!;
    const clearButton = toolbarButtons.find((button) => button.querySelector('[data-testid="DeleteSweepIcon"]'))!;
    const fullscreenButton = toolbarButtons.find((button) => button.querySelector('[data-testid="FullscreenIcon"]'))!;
    fireEvent.click(copyButton);
    expect(clipboard.copy).toHaveBeenCalledWith(expect.stringContaining('request failed'));
    fireEvent.click(downloadButton);
    expect(URL.createObjectURL).toHaveBeenCalled();
    fireEvent.click(fullscreenButton);
    expect(useDockStore.getState().maximized).toBe(true);
    fireEvent.click(clearButton);
    expect(screen.getByText('0/0 lines')).toBeInTheDocument();

    view.unmount();
    expect(socket().close).toHaveBeenCalledWith(1000, 'log session changed');
  }, 15_000);

  it('applies pod/container selection and persists workload container choices', () => {
    render(<LogViewer tab={logsTab()} />);
    fireEvent.click(screen.getByLabelText('Select log pods and containers'));
    const items = screen.getAllByRole('menuitem');
    const webA = items.find((item) => item.querySelector('.MuiListItemText-primary')?.textContent === 'web-a')!;
    const sidecar = items.find((item) => item.querySelector('.MuiListItemText-primary')?.textContent === 'sidecar')!;
    fireEvent.click(webA);
    fireEvent.click(sidecar);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket().url).toContain('pods=web-b');
    expect(socket().url).toContain('containers=app');
    expect(useLogPrefsStore.getState().enabledContainersByWorkload).toEqual({
      'dev%2Fx/team-a/Deployment/web': ['app'],
    });

    fireEvent.click(screen.getByLabelText('Select log pods and containers'));
    const onlyPod = screen.getByRole('menuitem', { name: /web-b/ });
    expect(onlyPod).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('handles interrupted, resumed, complete, empty, and exhausted socket sessions', () => {
    render(<LogViewer tab={logsTab({ pods: ['web-a'], sources: [{ pod: 'web-a', containers: ['app'] }] })} />);
    const first = socket();
    act(() => {
      first.open();
      first.message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T11:59:59.000Z', line: 'INFO once' });
    });
    flushLines();

    act(() => first.serverClose());
    expect(screen.getByText('reconnecting')).toBeInTheDocument();
    void act(() => vi.advanceTimersByTime(500));
    const second = socket();
    expect(second.url).toContain('resumeAt=');
    act(() => {
      second.open();
      second.message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T11:59:59.000Z', line: 'INFO once' });
      second.message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T12:00:00.000Z', line: 'INFO twice' });
    });
    flushLines();
    expect(screen.getAllByText(/INFO once/)).toHaveLength(1);
    expect(screen.getByText(/Reconnected after 1 attempt/)).toBeInTheDocument();
    void act(() => vi.advanceTimersByTime(10_000));

    act(() => second.serverClose(LOG_SOCKET_COMPLETE_CODE));
    expect(screen.getByText('complete')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select log pods and containers'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => second.serverClose(LOG_SOCKET_NO_STREAMS_CODE));
    expect(screen.getByText('disconnected')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Reconnect log stream'));
    expect(screen.getByText('connecting')).toBeInTheDocument();

    let current = socket();
    for (let attempt = 0; attempt < 9; attempt++) {
      act(() => current.serverClose());
      if (attempt < 8) {
        void act(() => vi.runOnlyPendingTimers());
        current = socket();
      }
    }
    expect(screen.getByText('disconnected')).toBeInTheDocument();
  });

  it.each([
    [{ previous: true }, 'terminated'],
    [{ sinceSeconds: 600 }, '10m'],
    [{ sinceSeconds: 3_600 }, '1h'],
    [{ sinceSeconds: 21_600 }, '6h'],
    [{ sinceSeconds: 86_400 }, '24h'],
    [{ sinceSeconds: 2_592_000 }, '30d'],
    [{ follow: false, tailLines: 20_000 }, 'last20k'],
  ] as Array<[Partial<LogsTab>, string]>)('derives the initial time mode from %j', (overrides, expected) => {
    const view = render(<LogViewer tab={logsTab(overrides)} />);
    expect(screen.getByRole('combobox')).toHaveTextContent(
      expected === 'terminated' ? 'Terminated' : expected === 'last20k' ? 'Last 20k' : `${expected} ago`,
    );
    view.unmount();
  });
});
