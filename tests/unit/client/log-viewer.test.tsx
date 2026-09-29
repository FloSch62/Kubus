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
  useLogPrefsStore.setState({ wrap: false, tsMode: 'off', highlight: true, view: 'message', enabledContainersByWorkload: {} });
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
    // A workload tab follows the workload instead of a frozen pod list.
    expect(socket().url).toContain('target=Deployment');
    expect(socket().url).toContain('targetName=web');
    expect(socket().url).not.toContain('pods=');
    expect(socket().url).not.toContain('containers=');
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

    // Stepping through matches held the live view; markers added while paused wait with the new lines.
    const viewMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Log view options' }));
    viewMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Add marker/ }));
    expect(screen.getByText('Paused · 1 marker · resume')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Resume log view'));
    viewMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Add marker/ }));
    fireEvent.keyDown(view.container.firstElementChild!, { key: ' ' });
    expect(screen.getAllByText(/Marker ·/).length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Log view options' }), { key: ' ' });

    viewMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /^Syntax highlighting/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Wrap long lines' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local time' }));
    expect(screen.getByRole('menuitemradio', { name: 'Local time' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('Pause log view'));
    fireEvent.click(screen.getByLabelText('Resume log view'));
    expect(useLogPrefsStore.getState()).toMatchObject({ wrap: true, tsMode: 'local', highlight: false });

    const output = screen.getByLabelText('Log output');
    Object.defineProperties(output, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(output);

    fireEvent.click(screen.getByRole('button', { name: 'Copy visible logs' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^As shown/ }));
    expect(clipboard.copy).toHaveBeenCalledWith(expect.stringContaining('request failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Download visible logs' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Raw/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    viewMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear buffer' }));
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
    expect(socket().url).toContain('exclude=web-a');
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

describe('LogViewer workload following', () => {
  function podNames(): string[] {
    fireEvent.click(screen.getByLabelText('Select log pods and containers'));
    const names = screen
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.MuiListItemText-primary')?.textContent ?? '')
      .filter((name) => name.startsWith('web-'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    return names;
  }

  it('tracks the pods a rollout brings and retires, with dividers and a waiting state', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => {
      socket().open();
      socket().message({ op: 'pods', pods: [{ pod: 'web-a', containers: ['app'] }, { pod: 'web-b', containers: ['app'] }] });
      socket().message({ op: 'pod-status', pod: 'web-a', container: 'app', state: 'streaming' });
      socket().message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T11:59:58.000Z', line: 'INFO old pod' });
      socket().message({ op: 'pod-joined', pod: 'web-c', containers: ['app'] });
      socket().message({ op: 'pod-status', pod: 'web-c', container: 'app', state: 'waiting', message: 'ContainerCreating' });
    });
    flushLines();
    expect(screen.getByText('web-c joined')).toBeInTheDocument();
    expect(screen.getByText('1 waiting')).toBeInTheDocument();
    expect(podNames()).toEqual(['web-a', 'web-b', 'web-c']);

    act(() => {
      socket().message({ op: 'pod-status', pod: 'web-c', container: 'app', state: 'streaming' });
      socket().message({ op: 'pod-left', pod: 'web-a', reason: 'terminated' });
      socket().message({ op: 'pod-left', pod: 'web-b', reason: 'deleted' });
    });
    flushLines();
    expect(screen.queryByText('1 waiting')).not.toBeInTheDocument();
    expect(screen.getByText('web-a terminated')).toBeInTheDocument();
    expect(screen.getByText('web-b deleted')).toBeInTheDocument();
    expect(podNames()).toEqual(['web-c']);
    // Pod changes never reconnect the socket.
    expect(MockWebSocket.instances).toHaveLength(1);

    // A retired pod's resume cursor is dropped, so a reconnect does not ask for it.
    act(() => socket().serverClose());
    void act(() => vi.advanceTimersByTime(500));
    expect(decodeURIComponent(socket().url)).not.toContain('web-a/app');

    // A snapshot after the reconnect reports what changed while the socket was down.
    act(() => {
      socket().open();
      socket().message({ op: 'pods', pods: [{ pod: 'web-d', containers: ['app'] }] });
    });
    flushLines();
    expect(screen.getByText('web-c terminated')).toBeInTheDocument();
    expect(screen.getByText('web-d joined')).toBeInTheDocument();
  });

  it('shows a waiting state while a followed workload has no running containers', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => {
      socket().open();
      socket().message({ op: 'pods', pods: [] });
    });
    expect(screen.getByText('waiting')).toBeInTheDocument();
    act(() => {
      socket().message({ op: 'pod-joined', pod: 'web-z', containers: ['app'] });
      socket().message({ op: 'pod-status', pod: 'web-z', container: 'app', state: 'waiting', message: 'PodInitializing' });
    });
    expect(screen.getByText('waiting')).toBeInTheDocument();
    act(() => socket().message({ op: 'pod-status', pod: 'web-z', container: 'app', state: 'streaming' }));
    expect(screen.getByText('streaming')).toBeInTheDocument();
  });

  it('keeps pods picked by hand as a fixed set and marks deleted ones', () => {
    render(<LogViewer tab={logsTab({ target: undefined, title: 'logs: 2 pods' })} />);
    expect(socket().url).toContain('pods=web-a%2Cweb-b');
    expect(socket().url).not.toContain('target=');
    act(() => {
      socket().open();
      socket().message({ op: 'pod-left', pod: 'web-a', reason: 'deleted' });
      socket().message({ op: 'pod-left', pod: 'web-a', reason: 'deleted' });
    });
    flushLines();
    expect(screen.getAllByText('web-a deleted')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Select log pods and containers'));
    expect(screen.getByRole('menuitem', { name: /web-a/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('applies remembered container choices to pods that join later', () => {
    useLogPrefsStore.setState({ enabledContainersByWorkload: { 'dev%2Fx/team-a/Deployment/web': ['app'] } });
    render(<LogViewer tab={logsTab()} />);
    expect(socket().url).toContain('containers=app');
    act(() => {
      socket().open();
      socket().message({ op: 'pod-joined', pod: 'web-c', containers: ['app', 'sidecar'] });
    });
    // The new pod joins without reconnecting; the server applies the same container filter to it.
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe('LogViewer reading tools', () => {
  function sendLines(lines: Array<[string, string]>): void {
    act(() => {
      for (const [ts, line] of lines) socket().message({ op: 'line', pod: 'web-a', container: 'app', ts, line });
    });
    flushLines();
  }

  it('pauses by buffering new lines and resumes with all of them', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => socket().open());
    sendLines([['2026-07-22T11:59:50.000Z', 'INFO first']]);
    fireEvent.click(screen.getByLabelText('Pause log view'));
    sendLines([
      ['2026-07-22T11:59:51.000Z', 'INFO second'],
      ['2026-07-22T11:59:52.000Z', 'INFO third'],
    ]);
    expect(screen.getByText('1/1 lines')).toBeInTheDocument();
    expect(screen.queryByText(/INFO second/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('2 new lines · resume'));
    expect(screen.getByText('3/3 lines')).toBeInTheDocument();
    expect(screen.getByText(/INFO third/)).toBeInTheDocument();
    expect(screen.queryByText(/new lines · resume/)).not.toBeInTheDocument();
  });

  it('orders lines from several pods by time', () => {
    const view = render(<LogViewer tab={logsTab()} />);
    act(() => {
      socket().open();
      socket().message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T11:59:51.000Z', line: 'a1' });
      socket().message({ op: 'line', pod: 'web-a', container: 'app', ts: '2026-07-22T11:59:53.000Z', line: 'a3' });
    });
    flushLines();
    // web-b's backlog arrives after web-a's.
    act(() => {
      socket().message({ op: 'line', pod: 'web-b', container: 'app', ts: '2026-07-22T11:59:50.000Z', line: 'b0' });
      socket().message({ op: 'line', pod: 'web-b', container: 'app', ts: '2026-07-22T11:59:52.000Z', line: 'b2' });
    });
    flushLines();
    const rows = [...view.container.querySelectorAll('[data-idx]')].map((row) => row.textContent?.slice(-2));
    expect(rows).toEqual(['b0', 'a1', 'b2', 'a3']);
  });

  it('excludes matching lines and honours match case in both filters', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => socket().open());
    sendLines([
      ['2026-07-22T11:59:50.000Z', 'GET /healthz 200'],
      ['2026-07-22T11:59:51.000Z', 'INFO Ready'],
      ['2026-07-22T11:59:52.000Z', 'INFO ready again'],
    ]);
    fireEvent.change(screen.getByPlaceholderText('Exclude (regex)…'), { target: { value: 'healthz' } });
    expect(screen.getByText('2/3 lines')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Filter (regex)…'), { target: { value: 'Ready' } });
    expect(screen.getByText('2/3 lines')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    expect(screen.getByText('1/3 lines')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Filter (regex)…'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('Exclude (regex)…'), { target: { value: 'READY' } });
    expect(screen.getByText('3/3 lines')).toBeInTheDocument();
    const exclude = screen.getByPlaceholderText('Exclude (regex)…');
    fireEvent.keyDown(exclude, { key: 'Escape' });
    expect(exclude).toHaveValue('');
  });

  it.each([
    ['As shown', 'web-a/app INFO ready'],
    ['Raw', 'INFO ready'],
    ['With timestamps', '2026-07-22T11:59:50.000Z [web-a/app] INFO ready'],
    ['NDJSON', '{"ts":"2026-07-22T11:59:50.000Z","pod":"web-a","container":"app","level":"info","message":"INFO ready"}'],
  ])('copies the visible lines %s', async (format, expected) => {
    render(<LogViewer tab={logsTab()} />);
    act(() => socket().open());
    sendLines([['2026-07-22T11:59:50.000Z', 'INFO ready']]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible logs' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${format}`) }));
    });
    expect(clipboard.copy).toHaveBeenLastCalledWith(expected);
  });

  it('expands a JSON line into a field table', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => socket().open());
    sendLines([['2026-07-22T11:59:50.000Z', '{"level":"info","msg":"served","http":{"status":200}}']]);
    fireEvent.click(screen.getByRole('button', { name: 'Expand 3 fields' }));
    const table = screen.getByRole('table', { name: 'Log line fields' });
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['level', 'msg', 'http.status']);
    // Expanding holds the live view so the table stays put.
    expect(screen.getByLabelText('Resume log view')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse fields' }));
    expect(screen.queryByRole('table', { name: 'Log line fields' })).not.toBeInTheDocument();
    // Clicking the line itself toggles it too, unless text is being selected.
    fireEvent.click(screen.getByText('served'));
    expect(screen.getByRole('table', { name: 'Log line fields' })).toBeInTheDocument();
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, toString: () => 'served' } as unknown as Selection);
    // The open field table repeats the value; the log line comes first.
    fireEvent.click(screen.getAllByText('served')[0]!);
    expect(screen.getByRole('table', { name: 'Log line fields' })).toBeInTheDocument();
    selection.mockRestore();
  });

  it('shows structured lines message first and switches to the raw text', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => socket().open());
    sendLines([['2026-07-22T11:59:50.000Z', '{"level":"warn","ts":"2026-07-22T11:59:50Z","msg":"slow upstream","http":{"status":504}}']]);
    const output = screen.getByLabelText('Log output');
    expect(output.textContent).toContain('WARN  slow upstream  http.status=504');
    expect(output.textContent).not.toContain('ts=');
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(useLogPrefsStore.getState().view).toBe('raw');
    expect(output.textContent).toContain('"msg":"slow upstream"');
    fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    expect(useLogPrefsStore.getState().view).toBe('message');
  });

  it('tags lines with the short pod suffix and keeps the full name in the tooltip', () => {
    render(
      <LogViewer
        tab={logsTab({
          pods: ['podinfo-5c7cdc845b-bp4xq', 'podinfo-5c7cdc845b-cpkl2'],
          sources: [
            { pod: 'podinfo-5c7cdc845b-bp4xq', containers: ['podinfo'] },
            { pod: 'podinfo-5c7cdc845b-cpkl2', containers: ['podinfo'] },
          ],
        })}
      />,
    );
    act(() => socket().open());
    act(() => socket().message({ op: 'line', pod: 'podinfo-5c7cdc845b-bp4xq', container: 'podinfo', ts: '2026-07-22T11:59:50.000Z', line: 'ready' }));
    flushLines();
    const tag = screen.getByText('bp4xq');
    expect(tag).toHaveAttribute('title', 'podinfo-5c7cdc845b-bp4xq/podinfo');
  });

  it('does not offer fields for plain lines', () => {
    render(<LogViewer tab={logsTab()} />);
    act(() => socket().open());
    sendLines([['2026-07-22T11:59:50.000Z', 'just words here']]);
    fireEvent.click(screen.getByText(/just words here/));
    expect(screen.queryByRole('button', { name: /^Expand/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Log line fields' })).not.toBeInTheDocument();
  });
});
