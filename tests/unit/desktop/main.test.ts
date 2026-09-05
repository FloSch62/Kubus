import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  }
  const quit = vi.fn();
  return { events, requests, messages, Window, menu, close, quit, openExternal: vi.fn(), showMessageBox: vi.fn(async () => ({})), cursor: { x: 2000, y: 2000 } };
});
vi.mock('electrobun/main', () => ({
  default: { events: { on: (name: string, callback: any) => native.events.set(name, callback) } },
  ApplicationMenu: { setApplicationMenu: native.menu },
  BrowserWindow: native.Window,
  BrowserView: { defineRPC: ({ handlers }: any) => {
    native.requests.push(handlers.requests); native.messages.push(handlers.messages);
    return { send: Object.fromEntries(['stateChanged', 'stateWriteFailed', 'closeTab', 'cycleTab', 'openRoute'].map((name) => [name, vi.fn()])) };
  } },
  BuildConfig: { get: async () => ({ isPackaged: false }) },
  Screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], getCursorScreenPoint: () => native.cursor },
  Utils: { quit: native.quit, openExternal: native.openExternal, showMessageBox: native.showMessageBox },
}));
vi.mock('fix-path', () => ({ default: vi.fn() }));
vi.mock('@kubus/server', () => ({
  startServer: vi.fn(async () => ({ url: 'http://127.0.0.1:42111/?token=unit-secret', close: native.close })),
  appendAppLog: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: any[]) => String(args[0]).endsWith('/preload.js') ? '// preload' : (fs.readFileSync as any)(...args) };
});
let dir: string;
let signalHandlers: Map<string, Set<(...args: any[]) => void>>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  native.Window.all.length = 0; native.requests.length = 0; native.messages.length = 0; native.events.clear();
  native.cursor = { x: 2000, y: 2000 };
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
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
async function boot() {
  await import('../../../desktop/src/main.js');
  await vi.waitFor(() => expect(native.Window.all).toHaveLength(1));
  return native.Window.all[0]!;
}

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

it('caches update checks until explicitly refreshed', async () => {
  await boot();
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: '0.9.0' })));
  vi.stubGlobal('fetch', fetcher);
  await native.requests[0]!.checkForUpdate!({});
  await native.requests[0]!.checkForUpdate!({});
  expect(fetcher).toHaveBeenCalledOnce();
  await native.requests[0]!.checkForUpdate!({ force: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
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
