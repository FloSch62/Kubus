import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const events = new Map<string, (event: { data: Record<string, unknown>; response?: unknown }) => void>();
  const requests: Array<Record<string, (...args: any[]) => any>> = [];
  const messages: Array<Record<string, (...args: any[]) => any>> = [];
  const menu = vi.fn();
  const close = vi.fn(async () => {});
  class Window {
    static all: Window[] = [];
    handlers = new Map<string, () => void>();
    webview: any;
    frame: any;
    maximized = false;
    minimized = false;
    visible = true;
    fullscreen = false;
    zoom = 1;
    constructor(public options: any) {
      this.frame = { x: 20, y: 20, ...options.frame };
      this.webview = { rpc: options.rpc, on: vi.fn(), executeJavascript: vi.fn(), openDevTools: vi.fn() };
      Window.all.push(this);
    }
    on(name: string, callback: () => void) { this.handlers.set(name, callback); }
    getFrame() { return this.frame; }
    isMaximized() { return this.maximized; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value: boolean) { this.fullscreen = value; }
    maximize() { this.maximized = true; this.handlers.get('resize')?.(); }
    unmaximize() { this.maximized = false; this.handlers.get('resize')?.(); }
    minimize() { this.minimized = true; }
    unminimize() { this.minimized = false; }
    activate = vi.fn();
    requestClose() { this.handlers.get('will-close')?.(); this.handlers.get('close')?.(); }
    getPageZoom() { return this.zoom; }
    setPageZoom(value: number) { this.zoom = value; }
    setWindowButtonPosition = vi.fn();
  }
  const quit = vi.fn();
  return { startServer: vi.fn(), updater: { onStatusChange: vi.fn(), getLocalInfo: vi.fn(async () => ({ version: '0.9.0', channel: 'stable', baseUrl: 'https://example.com' })), checkForUpdate: vi.fn(), downloadUpdate: vi.fn(), applyUpdate: vi.fn(), updateInfo: vi.fn(), clearStatusHistory: vi.fn(), getStatusHistory: vi.fn() }, packaged: false, events, requests, messages, Window, menu, close, quit, openExternal: vi.fn(), showMessageBox: vi.fn(async () => ({})), cursor: { x: 2000, y: 2000 }, legacyFile: undefined as string | undefined };
});
vi.mock('../../../desktop/src/paths.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../desktop/src/paths.js')>(),
  legacyClientStatePath: () => native.legacyFile,
}));
vi.mock('electrobun/main', () => ({
  default: { events: { on: (name: string, callback: any) => native.events.set(name, callback) } },
  ApplicationMenu: { setApplicationMenu: native.menu },
  BrowserWindow: native.Window,
  BrowserView: { defineRPC: ({ handlers }: any) => {
    native.requests.push(handlers.requests); native.messages.push(handlers.messages);
    return { send: Object.fromEntries(['updateStateChanged', 'stateChanged', 'stateWriteFailed', 'closeTab', 'cycleTab', 'openRoute'].map((name) => [name, vi.fn()])) };
  } },
  Updater: native.updater,
  BuildConfig: { get: async () => ({ isPackaged: native.packaged }) },
  Screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], getCursorScreenPoint: () => native.cursor },
  Utils: { quit: native.quit, openExternal: native.openExternal, showMessageBox: native.showMessageBox },
}));
vi.mock('fix-path', () => ({ default: vi.fn() }));
vi.mock('@kubus/server', () => ({
  startServer: native.startServer,
  appendAppLog: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: any[]) => path.basename(String(args[0])) === 'preload.js' ? '// preload' : (fs.readFileSync as any)(...args) };
});
const platform = process.platform;
let dir: string;
let signalHandlers: Map<string, Set<(...args: any[]) => void>>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  native.Window.all.length = 0; native.requests.length = 0; native.messages.length = 0; native.events.clear();
  native.startServer.mockResolvedValue({ port: 42111, token: 'unit-secret', url: 'http://127.0.0.1:42111/?token=unit-secret', close: native.close });
  native.packaged = false;
  native.updater.checkForUpdate.mockResolvedValue({ version: '1.0.0', updateAvailable: true, updateReady: false, error: '' });
  native.updater.updateInfo.mockReturnValue({ version: '1.0.0', updateAvailable: true, updateReady: true, error: '' });
  native.updater.getStatusHistory.mockReturnValue([]);
  native.updater.applyUpdate.mockReset();
  native.close.mockResolvedValue();
  native.cursor = { x: 2000, y: 2000 };
  native.legacyFile = undefined;
  dir = mkdtempSync(path.join(tmpdir(), 'kubus-main-'));
  vi.stubEnv('KUBUS_DESKTOP_DATA', dir);
  vi.stubEnv('KUBUS_DEEP_LINK', '');
  vi.stubGlobal('BroadcastChannel', class { postMessage = vi.fn(); onmessage = null; close() {} });
  signalHandlers = new Map(['SIGTERM', 'SIGINT', 'uncaughtExceptionMonitor'].map((name) => [name, new Set(process.listeners(name as NodeJS.Signals))]));
});
afterEach(async () => {
  native.events.get('before-quit')?.({ data: {} });
  await vi.waitFor(() => expect(native.quit).toHaveBeenCalled());
  for (const [name, original] of signalHandlers) for (const listener of process.listeners(name as NodeJS.Signals)) if (!original.has(listener)) EventEmitter.prototype.removeListener.call(process, name as NodeJS.Signals, listener);
  Object.defineProperty(process, 'platform', { value: platform });
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
async function boot() {
  await import('../../../desktop/src/main.js');
  await vi.waitFor(() => expect(native.Window.all).toHaveLength(1));
  return native.Window.all[0]!;
}

it('quits after a startup failure before client state is initialized', async () => {
  const blockedData = path.join(dir, 'not-a-directory');
  writeFileSync(blockedData, 'keep this file');
  vi.stubEnv('KUBUS_DESKTOP_DATA', blockedData);

  await import('../../../desktop/src/main.js');
  await vi.waitFor(() => expect(native.quit).toHaveBeenCalledOnce());

  expect(native.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'Kubus failed to start' }));
  expect(native.startServer).not.toHaveBeenCalled();
  expect(native.Window.all).toHaveLength(0);
  expect(readFileSync(blockedData, 'utf8')).toBe('keep this file');
});

it.each(['linux', 'darwin', 'win32'])('imports legacy preferences before the first renderer bootstrap on %s', async (host) => {
  Object.defineProperty(process, 'platform', { value: host });
  native.legacyFile = path.join(dir, 'legacy-client-state.json');
  const values = { tabs: '["/pods"]', favorites: '["Pods"]', theme: 'dark' };
  writeFileSync(native.legacyFile, JSON.stringify(values));
  await boot();
  expect(native.requests[0]!.bootstrap!().state).toEqual(values);
  expect(JSON.parse(readFileSync(path.join(dir, 'client-state.json'), 'utf8'))).toEqual(values);
  expect(JSON.parse(readFileSync(native.legacyFile, 'utf8'))).toEqual(values);
});

it('owns a Bun server, constrains navigation, and persists state across native windows', async () => {
  const win = await boot();
  expect(win.options.navigationRules).toBe('["^*","http://127.0.0.1:42111/*"]');
  expect(native.requests[0]!.bootstrap!()).toMatchObject({ state: {} });
  expect(native.requests[0]!.getAppInfo!()).toMatchObject({ name: 'Kubus', version: '0.9.0' });
  const launch = { kind: 'page', windowId: 'page', title: 'Pods', tab: { path: '/pods' } };
  native.messages[0]!.openWindow!(launch);
  const other = native.Window.all[1]!;
  expect(other.options.title).toBe('Pods — Kubus');
  native.messages[0]!.stateChanged!({ name: 'theme', value: 'dark' });
  expect(other.webview.rpc.send.stateChanged).toHaveBeenCalledWith({ name: 'theme', value: 'dark' });
  expect(native.requests[1]!.bootstrap!()).toMatchObject({ launch, state: { theme: 'dark' } });
  native.messages[1]!.stateChanged!({ name: 'theme', value: null });
  expect(native.requests[0]!.bootstrap!().state).toEqual({});
  native.messages[0]!.stateChanged!({ name: 7, value: false });
  native.messages[0]!.openWindow!({ kind: 'invalid' });
  expect(native.Window.all).toHaveLength(2);
  native.messages[0]!.minimizeWindow!(); expect(win.minimized).toBe(true);
  native.messages[0]!.toggleMaximize!(); expect(win.maximized).toBe(true);
  native.messages[0]!.toggleMaximize!(); expect(win.maximized).toBe(false);
  native.messages[0]!.closeWindow!();
  expect(native.close).not.toHaveBeenCalled();
  native.messages[1]!.closeWindow!();
  await vi.waitFor(() => expect(native.close).toHaveBeenCalledOnce());
  expect(readFileSync(path.join(dir, 'window-state.json'), 'utf8')).toContain('1440');
});

it('routes links only to application surfaces and recreates an application beside utilities', async () => {
  vi.stubEnv('KUBUS_DEEP_LINK', 'kubus://pods');
  const win = await boot();
  expect(native.requests[0]!.getPendingRoute!()).toBe('/pods');
  expect(native.requests[0]!.getPendingRoute!()).toBeNull();
  native.events.get('open-url')!({ data: { url: 'kubus://deployments' } });
  expect(win.webview.rpc.send.openRoute).toHaveBeenCalledWith('/deployments');
  native.messages[0]!.openWindow!({ kind: 'dock', windowId: 'utility', title: 'Logs', tab: { kind: 'logs', title: 'Logs' } });
  expect(native.requests[1]!.getPendingRoute!()).toBeNull();
  native.messages[0]!.closeWindow!();
  native.events.get('open-url')!({ data: { url: 'kubus://services' } });
  expect(native.Window.all).toHaveLength(3);
  expect(native.requests[2]!.getPendingRoute!()).toBe('/services');
});

it('detaches only validated transfers outside visible windows', async () => {
  await boot();
  const transfer = { kind: 'tab-transfer', surface: 'page', transferId: 'one', windowId: 'transfer', title: 'Moved' };
  native.cursor = { x: 30, y: 30 };
  expect(native.requests[0]!.detachTab!(transfer)).toBe(false);
  native.cursor = { x: 3000, y: 3000 };
  expect(native.requests[0]!.detachTab!(transfer)).toBe(true);
  expect(native.requests[0]!.detachTab!({})).toBe(false);
});

it('supports menus and rejects external URLs outside the allowed schemes', async () => {
  const win = await boot();
  const menu = (action: string) => native.events.get('application-menu-clicked')!({ data: { action } });
  menu('close-tab'); expect(win.webview.rpc.send.closeTab).toHaveBeenCalledOnce();
  menu('previous-tab'); menu('next-tab'); expect(win.webview.rpc.send.cycleTab).toHaveBeenCalledWith(true);
  menu('reload'); expect(win.webview.executeJavascript).toHaveBeenCalledWith('location.reload()');
  menu('devtools'); expect(win.webview.openDevTools).toHaveBeenCalledOnce();
  menu('zoom-in'); expect(win.zoom).toBeGreaterThan(1);
  menu('zoom-out'); menu('zoom-reset'); expect(win.zoom).toBe(1);
  menu('fullscreen'); expect(win.fullscreen).toBe(true);
  native.messages[0]!.openExternal!('https://example.com');
  native.messages[0]!.openExternal!('file:///etc/passwd');
  native.messages[0]!.openExternal!('invalid');
  expect(native.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com');
  menu('quit');
  await vi.waitFor(() => expect(native.quit).toHaveBeenCalledOnce());
});

it('retains deep links during reload and handles native focus and popup requests', async () => {
  const win = await boot();
  native.requests[0]!.getPendingRoute!();
  const willNavigate = win.webview.on.mock.calls.find(([name]: [string]) => name === 'will-navigate')[1];
  willNavigate();
  native.events.get('open-url')!({ data: { url: 'kubus://queued' } });
  expect(win.webview.rpc.send.openRoute).not.toHaveBeenCalled();
  expect(native.requests[0]!.getPendingRoute!()).toBe('/queued');
  win.handlers.get('focus')!();
  native.messages[0]!.windowAction!('reload');
  expect(win.webview.executeJavascript).toHaveBeenCalledWith('location.reload()');
  native.events.get('new-window-open')!({ data: { detail: { url: 'https://example.com/docs' } } });
  expect(native.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  native.events.get('reopen')!({ data: {} }); expect(win.activate).toHaveBeenCalled();
});

it('disables updates in development builds', async () => {
  await boot();
  native.messages[0]!.checkForUpdate!();
  expect(native.requests[0]!.bootstrap!().update.status).toBe('disabled');
  expect(native.updater.checkForUpdate).not.toHaveBeenCalled();
});

it('shares update state across windows and allows the native restart after server cleanup', async () => {
  native.packaged = true;
  const win = await boot();
  await vi.waitFor(() => expect(native.requests[0]!.bootstrap!().update.status).toBe('available'));
  native.messages[0]!.openWindow!({ kind: 'page', windowId: 'second', title: 'Pods', tab: { path: '/pods' } });
  const other = native.Window.all[1]!;
  native.messages[1]!.downloadUpdate!();
  await vi.waitFor(() => expect(native.requests[0]!.bootstrap!().update.status).toBe('ready'));
  expect(other.webview.rpc.send.updateStateChanged).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
  expect(win.webview.rpc.send.updateStateChanged).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
  native.messages[0]!.stateChanged!({ name: 'theme', value: 'dark' });
  native.updater.applyUpdate.mockImplementation(async () => {
    expect(native.close).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(dir, 'client-state.json'), 'utf8')).toContain('dark');
    const event = { data: {} };
    native.events.get('before-quit')!(event);
    expect(event).not.toHaveProperty('response');
    native.updater.getStatusHistory.mockReturnValue([{ status: 'launching-new-version' }]);
    native.quit();
  });
  native.messages[1]!.applyUpdate!();
  await vi.waitFor(() => expect(native.updater.applyUpdate).toHaveBeenCalledOnce());
  expect(native.requests[0]!.bootstrap!().update.status).toBe('installing');
});

it('restores the server after an update helper failure so installation can be retried', async () => {
  native.packaged = true;
  await boot();
  await vi.waitFor(() => expect(native.requests[0]!.bootstrap!().update.status).toBe('available'));
  native.messages[0]!.downloadUpdate!();
  await vi.waitFor(() => expect(native.requests[0]!.bootstrap!().update.status).toBe('ready'));
  native.updater.applyUpdate.mockImplementation(async () => {
    native.updater.getStatusHistory.mockReturnValue([{ status: 'launching-new-version' }, { status: 'error' }]);
    native.updater.updateInfo.mockReturnValue({ updateReady: true, error: 'Helper failed' });
  });
  native.messages[0]!.applyUpdate!();
  await vi.waitFor(() => expect(native.requests[0]!.bootstrap!().update).toMatchObject({ status: 'error', retry: 'install' }));
  expect(native.startServer).toHaveBeenCalledTimes(2);
  expect(native.startServer).toHaveBeenLastCalledWith(expect.objectContaining({ port: 42111, token: 'unit-secret' }));
  expect(native.quit).not.toHaveBeenCalled();
});

it('coalesces window geometry queries during a resize and flushes on close', async () => {
  const win = await boot();
  const frame = vi.spyOn(win, 'getFrame');
  const maximized = vi.spyOn(win, 'isMaximized');
  for (let i = 0; i < 100; i++) {
    win.frame.width = 1000 + i;
    win.handlers.get('resize')?.();
    win.handlers.get('move')?.();
  }
  expect(frame).not.toHaveBeenCalled();
  expect(maximized).not.toHaveBeenCalled();
  win.requestClose();
  expect(frame).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(path.join(dir, 'window-state.json'), 'utf8')).width).toBe(1099);
});
