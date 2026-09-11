import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const electron = vi.hoisted(() => {
  const appHandlers = new Map<string, Handler[]>();
  const ipcListeners = new Map<string, Handler>();
  const ipcHandlers = new Map<string, Handler>();

  class MockWebContents {
    readonly id = ++state.nextWebContentsId;
    readonly handlers = new Map<string, Handler>();
    readonly send = vi.fn();
    readonly undo = vi.fn();
    readonly redo = vi.fn();
    readonly cut = vi.fn();
    readonly copy = vi.fn();
    readonly paste = vi.fn();
    readonly pasteAndMatchStyle = vi.fn();
    readonly delete = vi.fn();
    readonly selectAll = vi.fn();
    readonly isDestroyed = vi.fn(() => false);
    readonly on = vi.fn((name: string, handler: Handler) => {
      this.handlers.set(name, handler);
      return this;
    });
    windowOpenHandler: Handler | undefined;
    readonly setWindowOpenHandler = vi.fn((handler: Handler) => {
      this.windowOpenHandler = handler;
    });
  }

  class MockBrowserWindow {
    static readonly instances: MockBrowserWindow[] = [];
    static readonly getFocusedWindow = vi.fn((): MockBrowserWindow | undefined => undefined);

    readonly handlers = new Map<string, Handler>();
    readonly webContents = new MockWebContents();
    readonly options: Record<string, unknown>;
    normalBounds = { width: 1280, height: 720, x: 20, y: 30 };
    maximized = false;
    minimized = false;

    readonly maximize = vi.fn(() => {
      this.maximized = true;
    });
    readonly isMaximized = vi.fn(() => this.maximized);
    readonly isMinimized = vi.fn(() => this.minimized);
    readonly isDestroyed = vi.fn(() => false);
    readonly isVisible = vi.fn(() => true);
    readonly getBounds = vi.fn(() => this.normalBounds);
    readonly restore = vi.fn(() => {
      this.minimized = false;
    });
    readonly focus = vi.fn();
    readonly show = vi.fn();
    readonly close = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);
    readonly setMenuBarVisibility = vi.fn();
    readonly setTitleBarOverlay = vi.fn();
    readonly getNormalBounds = vi.fn(() => this.normalBounds);
    readonly once = vi.fn((name: string, handler: Handler) => {
      this.handlers.set(name, handler);
      return this;
    });
    readonly on = vi.fn((name: string, handler: Handler) => {
      this.handlers.set(name, handler);
      return this;
    });

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockBrowserWindow.instances.push(this);
    }
  }

  const updateListeners = new Map<string, Handler>();
  const updater = {
    on: vi.fn((name: string, listener: Handler) => updateListeners.set(name, listener)),
    checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  };
  const app = {
    isPackaged: false,
    setName: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(() => true),
    getPath: vi.fn(() => state.userDataPath),
    getName: vi.fn(() => 'Kubus'),
    getAppPath: vi.fn(() => path.resolve(import.meta.dirname, '../../../electron')),
    relaunch: vi.fn(),
    getVersion: vi.fn(() => '0.6.1'),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(async () => undefined),
    quit: vi.fn(),
    exit: vi.fn(),
    on: vi.fn((name: string, handler: Handler) => {
      const handlers = appHandlers.get(name) ?? [];
      handlers.push(handler);
      appHandlers.set(name, handlers);
      return app;
    }),
  };
  const state = { userDataPath: '', nextWebContentsId: 0 };
  const serverClose = vi.fn(async (): Promise<void> => undefined);
  const startServer = vi.fn(async () => ({ url: 'http://127.0.0.1:41234/?token=secret-test-token', close: serverClose }));
  const appendAppLog = vi.fn();
  const fixPath = vi.fn();
  const menu = {
    buildFromTemplate: vi.fn(() => ({ id: 'application-menu' })),
    setApplicationMenu: vi.fn(),
  };
  const shell = { openExternal: vi.fn(async () => undefined) };
  const webContentsApi = { getFocusedWebContents: vi.fn((): MockWebContents | undefined => undefined) };

  return {
    app,
    appHandlers,
    updater,
    updateListeners,
    BrowserWindow: MockBrowserWindow,
    fixPath,
    appendAppLog,
    dialog: { showErrorBox: vi.fn() },
    ipcMain: {
      on: vi.fn((name: string, handler: Handler) => ipcListeners.set(name, handler)),
      handle: vi.fn((name: string, handler: Handler) => ipcHandlers.set(name, handler)),
    },
    ipcListeners,
    ipcHandlers,
    menu,
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 5000, y: 5000 })) },
    serverClose,
    shell,
    startServer,
    state,
    webContentsApi,
    MockWebContents,
  };
});

vi.mock('electron', () => ({
  app: electron.app,
  autoUpdater: {},
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
  Menu: electron.menu,
  nativeTheme: electron.nativeTheme,
  screen: electron.screen,
  shell: electron.shell,
  webContents: electron.webContentsApi,
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: electron.updater } }));
vi.mock('fix-path', () => ({ default: electron.fixPath }));
vi.mock('@kubus/server', () => ({ appendAppLog: electron.appendAppLog, startServer: electron.startServer }));

type EditMethod = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll';
interface MenuTemplateItem {
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  registerAccelerator?: boolean;
  click?: () => void;
  submenu?: MenuTemplateItem[];
}

const EDIT_METHODS: Record<string, EditMethod> = {
  Undo: 'undo',
  Redo: 'redo',
  Cut: 'cut',
  Copy: 'copy',
  Paste: 'paste',
  'Paste and Match Style': 'pasteAndMatchStyle',
  Delete: 'delete',
  'Select All': 'selectAll',
};

let userDataPath: string;
let previousHelmEngine: string | undefined;

function editMenuItems(): MenuTemplateItem[] {
  const template = (electron.menu.buildFromTemplate.mock.calls[0] as unknown[] | undefined)?.[0] as MenuTemplateItem[] | undefined;
  const edit = template?.find((item) => item.label === 'Edit');
  expect(edit?.submenu, 'Edit menu should be built').toBeDefined();
  return edit!.submenu!;
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

async function withWindowsStore(run: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'windowsStore');
  const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'windowsStore', { value: true, configurable: true });
  Object.defineProperty(process, 'resourcesPath', { value: userDataPath, configurable: true });
  try {
    await withPlatform('win32', run);
  } finally {
    if (original) Object.defineProperty(process, 'windowsStore', original);
    else Reflect.deleteProperty(process, 'windowsStore');
    if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
    else Reflect.deleteProperty(process, 'resourcesPath');
  }
}

function registered(map: Map<string, Handler>, name: string): Handler {
  const callback = map.get(name);
  expect(callback, `${name} should be registered`).toBeTypeOf('function');
  return callback!;
}

function appHandler(name: string): Handler {
  const callback = electron.appHandlers.get(name)?.[0];
  expect(callback, `${name} should be registered`).toBeTypeOf('function');
  return callback!;
}

async function loadMain() {
  await import('../../../electron/src/main.js');
  await vi.waitFor(() => expect(electron.BrowserWindow.instances).toHaveLength(1));
  return electron.BrowserWindow.instances[0]!;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  electron.appHandlers.clear();
  electron.updateListeners.clear();
  electron.ipcListeners.clear();
  electron.ipcHandlers.clear();
  electron.BrowserWindow.instances.length = 0;
  electron.BrowserWindow.getFocusedWindow.mockReturnValue(undefined);
  electron.webContentsApi.getFocusedWebContents.mockReturnValue(undefined);
  electron.app.isPackaged = false;
  electron.app.requestSingleInstanceLock.mockReturnValue(true);
  electron.app.whenReady.mockResolvedValue(undefined);
  electron.serverClose.mockResolvedValue(undefined);
  electron.startServer.mockResolvedValue({ url: 'http://127.0.0.1:41234/?token=secret-test-token', close: electron.serverClose });
  electron.nativeTheme.shouldUseDarkColors = false;
  electron.state.nextWebContentsId = 0;

  userDataPath = mkdtempSync(path.join(tmpdir(), 'kubus-electron-unit-'));
  electron.state.userDataPath = userDataPath;
  previousHelmEngine = process.env.KUBUS_HELM_ENGINE;
  delete process.env.KUBUS_HELM_ENGINE;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (previousHelmEngine === undefined) delete process.env.KUBUS_HELM_ENGINE;
  else process.env.KUBUS_HELM_ENGINE = previousHelmEngine;
  rmSync(userDataPath, { recursive: true, force: true });
});

describe('Electron main process', () => {
  it('starts the embedded server and creates a guarded native window', async () => {
    const win = await loadMain();

    expect(electron.fixPath).toHaveBeenCalledOnce();
    expect(electron.app.setName).toHaveBeenCalledWith('Kubus');
    expect(electron.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 0, openBrowser: false, prettyLogs: false }),
    );
    expect(win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:41234/?token=secret-test-token');
    const mainLogText = readFileSync(path.join(userDataPath, 'logs', 'main.log'), 'utf8');
    expect(mainLogText).toMatch(/Kubus 0\.6\.1 starting/);
    expect(mainLogText).toContain('server listening at http://127.0.0.1:41234');
    expect(mainLogText).not.toContain('secret-test-token');
    expect(electron.appendAppLog).toHaveBeenCalledWith('info', expect.stringContaining('Kubus 0.6.1 starting'), undefined);
    expect(electron.appendAppLog).toHaveBeenCalledWith('info', 'server listening at http://127.0.0.1:41234', undefined);
    expect(win.options).toMatchObject({
      minWidth: 800,
      minHeight: 500,
      title: 'Kubus',
      show: false,
      titleBarStyle: 'hidden',
    });
    expect(win.options.webPreferences).toEqual({
      preload: expect.stringMatching(/electron[\\/](?:src|dist)[\\/]preload\.js$/),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    });
    if (process.platform === 'darwin') expect(win.setMenuBarVisibility).not.toHaveBeenCalled();
    else expect(win.setMenuBarVisibility).toHaveBeenCalledWith(false);

    win.handlers.get('ready-to-show')?.();
    expect(win.show).toHaveBeenCalledOnce();

    win.webContents.handlers.get('render-process-gone')?.({}, { reason: 'crashed', exitCode: 9 });
    expect(electron.appendAppLog).toHaveBeenCalledWith('error', 'window renderer gone (crashed, exit code 9)', undefined);

    const result = win.webContents.windowOpenHandler?.({ url: 'https://example.com/docs' });
    expect(result).toEqual({ action: 'deny' });
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');

    const closeWindow = registered(electron.ipcListeners, 'kubus:close-window');
    closeWindow({ sender: {} });
    expect(win.close).not.toHaveBeenCalled();
    closeWindow({ sender: win.webContents });
    expect(win.close).toHaveBeenCalledOnce();
  });

  it('persists a filtered client snapshot and coalesces renderer writes', async () => {
    writeFileSync(
      path.join(userDataPath, 'client-state.json'),
      JSON.stringify({ theme: 'dark', unsafeNumber: 12, unsafeObject: { nested: true } }),
    );
    const win = await loadMain();
    const getAll = registered(electron.ipcListeners, 'kubus:state:get-all');
    const setItem = registered(electron.ipcListeners, 'kubus:state:set-item');
    const removeItem = registered(electron.ipcListeners, 'kubus:state:remove-item');

    const validEvent: { sender: unknown; returnValue?: unknown } = { sender: win.webContents };
    getAll(validEvent);
    expect(validEvent.returnValue).toEqual({ theme: 'dark' });

    const foreignEvent: { sender: unknown; returnValue?: unknown } = { sender: {} };
    getAll(foreignEvent);
    expect(foreignEvent.returnValue).toEqual({});

    vi.useFakeTimers();
    setItem({ sender: {} }, 'ignored', 'foreign renderer');
    setItem({ sender: win.webContents }, 'theme', 'light');
    setItem({ sender: win.webContents }, 'tabs', 'serialized-tabs');
    setItem({ sender: win.webContents }, 'bad-value', 123);
    await vi.advanceTimersByTimeAsync(151);

    const stateFile = path.join(userDataPath, 'client-state.json');
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ theme: 'light', tabs: 'serialized-tabs' });
    if (process.platform !== 'win32') expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    removeItem({ sender: win.webContents }, 'theme');
    await vi.advanceTimersByTimeAsync(151);
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ tabs: 'serialized-tabs' });
  });

  it('maps native close and tab-cycle accelerators onto renderer IPC', async () => {
    const win = await loadMain();
    const beforeInput = registered(win.webContents.handlers, 'before-input-event');

    const closeEvent = { preventDefault: vi.fn() };
    beforeInput(closeEvent, {
      type: 'keyDown',
      key: 'w',
      code: 'KeyW',
      alt: false,
      shift: false,
      control: process.platform !== 'darwin',
      meta: process.platform === 'darwin',
    });
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('kubus:close-tab');

    const nextEvent = { preventDefault: vi.fn() };
    beforeInput(nextEvent, {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      alt: false,
      shift: false,
      control: true,
      meta: false,
    });
    expect(nextEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('kubus:cycle-tab', false);

    const previousEvent = { preventDefault: vi.fn() };
    beforeInput(previousEvent, {
      type: 'keyDown',
      key: 'PageUp',
      code: 'PageUp',
      alt: false,
      shift: false,
      control: true,
      meta: false,
    });
    expect(previousEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('kubus:cycle-tab', true);

    const keyUp = { preventDefault: vi.fn() };
    beforeInput(keyUp, {
      type: 'keyUp',
      key: 'w',
      alt: false,
      shift: false,
      control: true,
      meta: false,
    });
    expect(keyUp.preventDefault).not.toHaveBeenCalled();
  });

  it('opens validated secondary windows and detaches only outside existing window bounds', async () => {
    const win = await loadMain();
    const openWindow = registered(electron.ipcListeners, 'kubus:open-window');
    const launch = {
      kind: 'page',
      windowId: 'window-page',
      title: 'Pods',
      context: { selected: ['kind-a'], namespaces: ['production'], navCollapsed: true },
      tab: { path: '/r/core/v1/pods' },
    };
    openWindow({ sender: win.webContents }, launch);
    expect(electron.BrowserWindow.instances).toHaveLength(2);
    expect(electron.BrowserWindow.instances[1]?.options.title).toBe('Pods — Kubus');
    expect(electron.BrowserWindow.instances[1]?.loadURL).toHaveBeenCalledWith('http://127.0.0.1:41234/?token=secret-test-token');

    openWindow({ sender: win.webContents }, { ...launch, tab: { path: '//evil.example' } });
    expect(electron.BrowserWindow.instances).toHaveLength(2);
    openWindow({ sender: win.webContents }, { ...launch, context: { selected: 'invalid', namespaces: [], navCollapsed: false } });
    expect(electron.BrowserWindow.instances).toHaveLength(2);

    const detach = registered(electron.ipcHandlers, 'kubus:detach-tab');
    expect(detach({ sender: win.webContents }, {
      kind: 'tab-transfer',
      surface: 'dock',
      windowId: 'window-transfer',
      title: 'Shell',
      transferId: 'opaque-token',
    })).toBe(true);
    expect(electron.BrowserWindow.instances).toHaveLength(3);

    electron.screen.getCursorScreenPoint.mockReturnValue({ x: 40, y: 40 });
    expect(detach({ sender: win.webContents }, {
      kind: 'tab-transfer',
      surface: 'dock',
      windowId: 'window-transfer-2',
      title: 'Shell',
      transferId: 'opaque-token-2',
    })).toBe(false);
    expect(electron.BrowserWindow.instances).toHaveLength(3);
  });

  it('queues deep links until the renderer is ready, then pushes subsequent routes', async () => {
    const win = await loadMain();
    const preventDefault = vi.fn();

    appHandler('open-url')({ preventDefault }, 'kubus://r/core/v1/pods?sel=cluster%7Cns%7Cpod');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.webContents.send).not.toHaveBeenCalledWith('kubus:open-route', expect.anything());

    const getPendingRoute = registered(electron.ipcHandlers, 'kubus:get-pending-route');
    expect(getPendingRoute({ sender: {} })).toBeNull();
    expect(getPendingRoute({ sender: win.webContents })).toBe('/r/core/v1/pods?sel=cluster%7Cns%7Cpod');
    expect(getPendingRoute({ sender: win.webContents })).toBeNull();

    appHandler('open-url')({ preventDefault: vi.fn() }, 'kubus://helm');
    expect(win.webContents.send).toHaveBeenCalledWith('kubus:open-route', '/helm');

    win.webContents.send.mockClear();
    appHandler('open-url')({ preventDefault: vi.fn() }, 'kubus:////example.com/escape');
    expect(win.webContents.send).not.toHaveBeenCalled();

    win.minimized = true;
    appHandler('second-instance')({}, ['kubus', 'kubus://events']);
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('kubus:open-route', '/events');
  });

  it('keeps deep links and saved bounds owned by full application windows', async () => {
    const win = await loadMain();
    const getPendingRoute = registered(electron.ipcHandlers, 'kubus:get-pending-route');
    expect(getPendingRoute({ sender: win.webContents })).toBeNull();

    const openWindow = registered(electron.ipcListeners, 'kubus:open-window');
    openWindow({ sender: win.webContents }, {
      kind: 'dock',
      windowId: 'utility-only',
      title: 'Logs',
      tab: { kind: 'logs', title: 'Logs', ctx: 'kind-a', namespace: 'default', pods: ['logger'] },
    });
    const utility = electron.BrowserWindow.instances[1]!;
    win.normalBounds = { width: 1400, height: 860, x: 30, y: 40 };
    utility.normalBounds = { width: 820, height: 520, x: 400, y: 300 };

    win.handlers.get('close')?.();
    win.handlers.get('closed')?.();
    expect(JSON.parse(readFileSync(path.join(userDataPath, 'window-state.json'), 'utf8'))).toEqual({
      width: 1400,
      height: 860,
      x: 30,
      y: 40,
      maximized: false,
    });
    // A utility renderer never advertises itself as a route-capable app.
    expect(getPendingRoute({ sender: utility.webContents })).toBeNull();

    appHandler('open-url')({ preventDefault: vi.fn() }, 'kubus://events?source=utility-only');
    expect(electron.BrowserWindow.instances).toHaveLength(3);
    const replacementApp = electron.BrowserWindow.instances[2]!;
    expect(utility.webContents.send).not.toHaveBeenCalledWith('kubus:open-route', expect.anything());
    expect(replacementApp.focus).toHaveBeenCalledOnce();
    expect(getPendingRoute({ sender: replacementApp.webContents })).toBe('/events?source=utility-only');

    utility.handlers.get('close')?.();
    utility.handlers.get('closed')?.();
    expect(JSON.parse(readFileSync(path.join(userDataPath, 'window-state.json'), 'utf8'))).toMatchObject({
      width: 1400,
      height: 860,
      x: 30,
      y: 40,
    });
  });

  it('rejects foreign update IPC and disables downloads in development', async () => {
    const win = await loadMain();
    const state = registered(electron.ipcHandlers, 'kubus:update:state');
    const check = registered(electron.ipcHandlers, 'kubus:update:check');
    const download = registered(electron.ipcHandlers, 'kubus:update:download');
    const install = registered(electron.ipcHandlers, 'kubus:update:install');
    expect(state({ sender: {} })).toBeUndefined();
    expect(check({ sender: {} })).toBeUndefined();
    expect(download({ sender: {} })).toBeUndefined();
    expect(install({ sender: {} })).toBe(false);
    expect(state({ sender: win.webContents })).toMatchObject({ status: 'disabled', reason: 'development' });
    await expect(check({ sender: win.webContents })).resolves.toMatchObject({ status: 'disabled' });
    await expect(download({ sender: win.webContents })).resolves.toMatchObject({ status: 'disabled' });
    expect(install({ sender: win.webContents })).toBe(false);
  });

  it.each([false, true])('hands off updates after server shutdown (stalled=%s)', async (stalled) => {
    vi.useFakeTimers();
    await withPlatform('win32', async () => {
      electron.app.isPackaged = true;
      Object.defineProperty(process, 'resourcesPath', { value: userDataPath, configurable: true });
      if (stalled) electron.serverClose.mockImplementationOnce(() => new Promise(() => {}));
      const win = await loadMain();
      registered(electron.updateListeners, 'update-available')({ version: '1.0.0' });
      const download = registered(electron.ipcHandlers, 'kubus:update:download');
      expect(download({ sender: {} })).toBeUndefined();
      const pending = download({ sender: win.webContents });
      registered(electron.updateListeners, 'update-downloaded')({ version: '1.0.0' });
      await pending;
      expect(win.webContents.send).toHaveBeenCalledWith('kubus:update:changed', expect.objectContaining({ status: 'ready' }));
      const install = registered(electron.ipcHandlers, 'kubus:update:install');
      expect(install({ sender: {} })).toBe(false);
      expect(install({ sender: win.webContents })).toBe(true);
      expect(install({ sender: win.webContents })).toBe(false);
      expect(electron.updater.quitAndInstall).not.toHaveBeenCalled();
      const preventDefault = vi.fn();
      appHandler('before-quit')({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(electron.serverClose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(stalled ? 5000 : 0);
      expect(electron.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
      expect(electron.app.exit).not.toHaveBeenCalled();
    });
  });

  it('leaves Store updates to Microsoft and only opens the Store on an explicit, trusted request', async () => {
    vi.useFakeTimers();
    await withWindowsStore(async () => {
      electron.app.isPackaged = true;
      const win = await loadMain();
      const state = registered(electron.ipcHandlers, 'kubus:update:state');
      const check = registered(electron.ipcHandlers, 'kubus:update:check');
      const download = registered(electron.ipcHandlers, 'kubus:update:download');
      const install = registered(electron.ipcHandlers, 'kubus:update:install');
      const managed = { status: 'disabled', currentVersion: '0.6.1', reason: 'store' };

      expect(electron.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
      expect(check({ sender: {} })).toBeUndefined();
      expect(state({ sender: win.webContents })).toEqual(managed);
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(electron.shell.openExternal).not.toHaveBeenCalled();
      expect(electron.updater.checkForUpdates).not.toHaveBeenCalled();

      await expect(check({ sender: win.webContents })).resolves.toEqual(managed);
      expect(electron.shell.openExternal).toHaveBeenCalledExactlyOnceWith('ms-windows-store://pdp/?ProductId=9PCTHB079SK7');
      await expect(download({ sender: win.webContents })).resolves.toEqual(managed);
      expect(install({ sender: win.webContents })).toBe(false);
      expect(electron.updater.downloadUpdate).not.toHaveBeenCalled();
      expect(electron.updater.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  it('reports a Store launch failure without falling back to GitHub downloads', async () => {
    await withWindowsStore(async () => {
      electron.app.isPackaged = true;
      electron.shell.openExternal.mockRejectedValueOnce(new Error('Store unavailable'));
      const win = await loadMain();
      const check = registered(electron.ipcHandlers, 'kubus:update:check');
      await expect(check({ sender: win.webContents })).rejects.toThrow('Store unavailable');
      expect(electron.updater.checkForUpdates).not.toHaveBeenCalled();
      expect(electron.updater.downloadUpdate).not.toHaveBeenCalled();
    });
  });

  it('restores window bounds, reports native capabilities, and closes the server before quitting', async () => {
    writeFileSync(
      path.join(userDataPath, 'window-state.json'),
      JSON.stringify({ width: 1100, height: 700, x: 8, y: 12, maximized: true }),
    );
    const enginePath = path.join(userDataPath, 'helm-engine.wasm.gz');
    writeFileSync(enginePath, 'engine');
    process.env.KUBUS_HELM_ENGINE = enginePath;

    const win = await loadMain();
    expect(win.options).toMatchObject({ width: 1100, height: 700, x: 8, y: 12 });
    expect(win.maximize).toHaveBeenCalledOnce();

    const appInfo = registered(electron.ipcHandlers, 'kubus:get-app-info');
    expect(appInfo({ sender: {} })).toBeUndefined();
    expect(appInfo({ sender: win.webContents })).toEqual({ name: 'Kubus', version: '0.6.1', helmEngine: true });

    win.normalBounds = { width: 900, height: 600, x: 40, y: 50 };
    win.maximized = false;
    win.handlers.get('close')?.();
    expect(JSON.parse(readFileSync(path.join(userDataPath, 'window-state.json'), 'utf8'))).toEqual({
      width: 900,
      height: 600,
      x: 40,
      y: 50,
      maximized: false,
    });

    const quitEvent = { preventDefault: vi.fn() };
    appHandler('before-quit')(quitEvent);
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(electron.serverClose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());
  });

  it('forces macOS to exit when server shutdown stalls, without restarting the deadline on repeated quits', async () => {
    await withPlatform('darwin', async () => {
      const win = await loadMain();
      vi.useFakeTimers();
      let finishClose!: () => void;
      electron.serverClose.mockImplementationOnce(() => new Promise<void>((resolve) => { finishClose = resolve; }));
      registered(electron.ipcListeners, 'kubus:state:set-item')({ sender: win.webContents }, 'quit-state', 'saved');

      const quitEvent = { preventDefault: vi.fn() };
      appHandler('before-quit')(quitEvent);
      expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(path.join(userDataPath, 'client-state.json'), 'utf8'))['quit-state']).toBe('saved');
      await vi.advanceTimersByTimeAsync(4_000);
      expect(electron.app.exit).not.toHaveBeenCalled();
      appHandler('before-quit')({ preventDefault: vi.fn() });
      expect(electron.serverClose).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(electron.app.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(readFileSync(path.join(userDataPath, 'logs', 'main.log'), 'utf8')).toContain('shutdown timed out');
      expect(readFileSync(path.join(userDataPath, 'window-state.json'), 'utf8')).toContain('1280');

      // A late completion must not request another quit after forced exit.
      finishClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(electron.app.quit).not.toHaveBeenCalled();
    });
  });

  it.each(['resolve', 'reject', 'throw'] as const)('cancels the shutdown deadline when close completes via %s', async (outcome) => {
    await loadMain();
    vi.useFakeTimers();
    const error = new Error('shutdown failure');
    if (outcome === 'reject') electron.serverClose.mockRejectedValueOnce(error);
    if (outcome === 'throw') electron.serverClose.mockImplementationOnce(() => { throw error; });

    appHandler('before-quit')({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    const resumedQuit = { preventDefault: vi.fn() };
    appHandler('before-quit')(resumedQuit);
    expect(resumedQuit.preventDefault).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(electron.app.exit).not.toHaveBeenCalled();
    if (outcome !== 'resolve') {
      expect(readFileSync(path.join(userDataPath, 'logs', 'main.log'), 'utf8')).toContain('shutdown failure');
    }
  });

  it('quits immediately when another instance owns the lock', async () => {
    electron.app.requestSingleInstanceLock.mockReturnValue(false);
    await import('../../../electron/src/main.js');

    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.app.whenReady).not.toHaveBeenCalled();
    expect(electron.startServer).not.toHaveBeenCalled();
    expect(electron.BrowserWindow.instances).toHaveLength(0);
  });

  it('records and reports an embedded-server startup failure', async () => {
    electron.startServer.mockRejectedValueOnce(new Error('address unavailable'));

    await import('../../../electron/src/main.js');
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());

    const logPath = path.join(userDataPath, 'logs', 'main.log');
    expect(readFileSync(logPath, 'utf8')).toContain('ERROR the embedded server failed to start');
    expect(electron.appendAppLog).toHaveBeenCalledWith(
      'error',
      'the embedded server failed to start',
      expect.objectContaining({ err: expect.stringContaining('address unavailable') }),
    );
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Kubus failed to start',
      expect.stringContaining(logPath),
    );
    expect(electron.BrowserWindow.instances).toHaveLength(0);
  });

  it('routes Edit menu commands to the focused web contents, then the key window, then the primary window', async () => {
    const win = await loadMain();
    const items = editMenuItems();
    const names = items.map((item) => item.label ?? item.type);
    if (process.platform === 'darwin') {
      expect(names).toEqual(['Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All', 'separator', 'Speech']);
    } else {
      expect(names).toEqual(['Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'Delete', 'separator', 'Select All']);
    }
    // Plain items, never predefined roles: a role's click is ignored and a
    // role only acts on the web contents Electron reports as focused.
    const commands = items.filter((item) => item.label && item.label !== 'Speech');
    expect(commands.every((item) => item.role === undefined && typeof item.click === 'function')).toBe(true);
    expect(commands.find((item) => item.label === 'Copy')).toMatchObject({ accelerator: 'CommandOrControl+C', registerAccelerator: false });
    expect(commands.find((item) => item.label === 'Redo')?.accelerator).toBe(process.platform === 'win32' ? 'Control+Y' : 'Shift+CommandOrControl+Z');
    expect(commands.find((item) => item.label === 'Delete')).not.toHaveProperty('accelerator');

    // The focused web contents wins, exactly like the predefined roles.
    const focused = new electron.MockWebContents();
    electron.webContentsApi.getFocusedWebContents.mockReturnValue(focused);
    const other = new electron.BrowserWindow({});
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(other);
    for (const item of commands) {
      item.click!();
      expect(focused[EDIT_METHODS[item.label!]!], item.label).toHaveBeenCalledOnce();
      expect(other.webContents[EDIT_METHODS[item.label!]!], item.label).not.toHaveBeenCalled();
    }

    // Without a focused web contents the key window receives the command.
    electron.webContentsApi.getFocusedWebContents.mockReturnValue(undefined);
    for (const item of commands) {
      item.click!();
      expect(other.webContents[EDIT_METHODS[item.label!]!], item.label).toHaveBeenCalledOnce();
      expect(win.webContents[EDIT_METHODS[item.label!]!], item.label).not.toHaveBeenCalled();
    }

    // No key window at all: the primary window is the last resort.
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(undefined);
    const copy = commands.find((item) => item.label === 'Copy')!;
    copy.click!();
    expect(win.webContents.copy).toHaveBeenCalledOnce();

    // Destroyed web contents are left alone.
    win.webContents.isDestroyed.mockReturnValue(true);
    copy.click!();
    expect(win.webContents.copy).toHaveBeenCalledOnce();
  });

  it('builds the macOS Edit menu with its extra commands and the Speech submenu', async () => {
    await withPlatform('darwin', async () => {
      const win = await loadMain();
      expect(win.setMenuBarVisibility).not.toHaveBeenCalled();
      const items = editMenuItems();
      expect(items.map((item) => item.label ?? item.type)).toEqual([
        'Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All', 'separator', 'Speech',
      ]);
      expect(items.find((item) => item.label === 'Paste and Match Style')?.accelerator).toBe('Cmd+Option+Shift+V');
      expect(items.find((item) => item.label === 'Speech')?.submenu).toEqual([{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]);
      for (const item of items.filter((entry) => entry.label && entry.label !== 'Speech')) {
        item.click!();
        expect(win.webContents[EDIT_METHODS[item.label!]!], item.label).toHaveBeenCalledOnce();
      }
    });
  });
});
