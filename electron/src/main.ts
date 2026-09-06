import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  webContents,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import fixPath from 'fix-path';
import electronUpdater from 'electron-updater';
import { DesktopUpdater, updateDisabledReason } from './updater.js';
import { startServer, type RunningServer } from '@kubus/server';
import type { AppWindowLaunch } from '@kubus/shared';
import { initMainLog, installCrashCapture, mainLog, mainLogPath } from './main-log.js';

// GUI apps on macOS/Linux don't inherit the shell PATH; kubeconfig exec
// plugins (aws, gke-gcloud-auth-plugin, kubelogin, ...) need it.
fixPath();

// Without this the Linux WM_CLASS becomes the package.json name
// ("@kubus/electron") and never matches the .desktop StartupWMClass,
// leaving the window without taskbar/dock icon.
app.setName('Kubus');
initMainLog(app.getPath('userData'));
installCrashCapture();
mainLog('info', `Kubus ${app.getVersion()} starting on ${process.platform}/${process.arch} (Electron ${process.versions.electron})`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// Must match the client TopBar height: its toolbar doubles as the titlebar.
const TITLEBAR_HEIGHT = 52;
const SHUTDOWN_TIMEOUT_MS = 5_000;

let primaryWindow: BrowserWindow | undefined;
let appUrl: string | undefined;
const managedWindows = new Set<BrowserWindow>();
const applicationWindows = new Set<BrowserWindow>();
const routeReadyWindows = new Set<BrowserWindow>();
const windowLaunches = new Map<number, AppWindowLaunch>();
let server: RunningServer | undefined;
let closing: Promise<void> | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let quittingForUpdate = false;

// ---- kubus:// deep links -------------------------------------------------
// The client is served from a random localhost port, so shareable links use
// the kubus:// scheme and carry only the in-app route; the renderer's router
// resolves it against whatever origin this instance runs on.

const PROTOCOL = 'kubus';
let pendingRoute: string | undefined;

/** kubus://r/apps/v1/deployments?sel=… → "/r/apps/v1/deployments?sel=…". */
function routeFromDeepLink(raw: string): string | undefined {
  if (!raw.startsWith(`${PROTOCOL}://`)) return undefined;
  const rest = raw.slice(`${PROTOCOL}://`.length);
  const route = rest.startsWith('/') ? rest : `/${rest}`;
  // Reject protocol-relative smuggling — only same-app routes may pass.
  return route.startsWith('//') ? undefined : route;
}

function openRoute(route: string): void {
  let win = primaryWindow;
  if (!win) {
    // A focused terminal/log window has no application router. Keep the route
    // pending and restore a full application window to receive it.
    pendingRoute = route;
    if (appUrl) win = createWindow(appUrl);
  } else if (routeReadyWindows.has(win)) {
    win.webContents.send('kubus:open-route', route);
  } else {
    // Cold start or mid-boot: held until the renderer pulls it.
    pendingRoute = route;
  }
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

if (app.isPackaged) {
  app.setAsDefaultProtocolClient(PROTOCOL);
} else if (process.argv[1]) {
  // Dev: register with explicit args so the OS can relaunch this checkout.
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
}

// macOS delivers deep links via open-url (cold starts queue until the window loads).
app.on('open-url', (event, url) => {
  event.preventDefault();
  const route = routeFromDeepLink(url);
  if (route) openRoute(route);
});

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

interface AppInfo {
  name: string;
  version: string;
  helmEngine: boolean;
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const clientStateFile = () => path.join(app.getPath('userData'), 'client-state.json');

function senderWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined {
  return [...managedWindows].find((win) => win.webContents === event.sender);
}

function isManagedWindowSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return senderWindow(event) !== undefined;
}

function isPrimaryWindowSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!primaryWindow && event.sender === primaryWindow.webContents;
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 900 };
  try {
    const state = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as WindowState;
    if (typeof state.width !== 'number' || typeof state.height !== 'number') return fallback;
    return state;
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getNormalBounds();
  const state: WindowState = { ...bounds, maximized: win.isMaximized() };
  try {
    writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch {
    /* state is a nicety; never block shutdown on it */
  }
}

let clientStateCache: Record<string, string> | undefined;

function loadClientState(): Record<string, string> {
  if (!clientStateCache) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(clientStateFile(), 'utf8'));
      clientStateCache =
        !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          ? {}
          : Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      clientStateCache = {};
    }
  }
  return clientStateCache;
}

function saveClientState(state: Record<string, string>): void {
  const file = clientStateFile();
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  clientStateCache = state;
}

interface EditCommand {
  label: string;
  accelerator?: string;
  /**
   * Windows/Linux only, mirroring the predefined role: the chord is shown but
   * not registered as a window-wide shortcut, so the renderer keeps handling
   * it natively. macOS ignores the flag and always binds the accelerator as
   * the menu item's key equivalent, which is how Cmd+C reaches `click`.
   */
  registerAccelerator?: boolean;
  run: (target: WebContents) => void;
}

/**
 * The Edit commands, mirroring Electron's predefined roles item for item.
 * They are plain items rather than roles because a role only ever acts on
 * the web contents Electron reports as focused, and its click handler is
 * documented as ignored. On macOS that lookup can come back empty while the
 * page still shows a selection (the renderer view is not the window's first
 * responder), so the stock editMenu dropped Cmd+C silently — and macOS has
 * no other copy path, unlike Linux/Windows where the renderer handles Ctrl+C
 * itself and never goes through the menu. These fall back to the key window.
 */
const EDIT_COMMANDS = {
  undo: { label: 'Undo', accelerator: 'CommandOrControl+Z', run: (target) => target.undo() },
  redo: { label: 'Redo', accelerator: isWindows ? 'Control+Y' : 'Shift+CommandOrControl+Z', run: (target) => target.redo() },
  cut: { label: 'Cut', accelerator: 'CommandOrControl+X', registerAccelerator: false, run: (target) => target.cut() },
  copy: { label: 'Copy', accelerator: 'CommandOrControl+C', registerAccelerator: false, run: (target) => target.copy() },
  paste: { label: 'Paste', accelerator: 'CommandOrControl+V', registerAccelerator: false, run: (target) => target.paste() },
  pasteAndMatchStyle: {
    label: 'Paste and Match Style',
    accelerator: isMac ? 'Cmd+Option+Shift+V' : 'Shift+CommandOrControl+V',
    registerAccelerator: false,
    run: (target) => target.pasteAndMatchStyle(),
  },
  delete: { label: 'Delete', run: (target) => target.delete() },
  selectAll: { label: 'Select All', accelerator: 'CommandOrControl+A', run: (target) => target.selectAll() },
} satisfies Record<string, EditCommand>;

function editItem(command: EditCommand): MenuItemConstructorOptions {
  const { label, accelerator, registerAccelerator, run } = command;
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    ...(registerAccelerator === undefined ? {} : { registerAccelerator }),
    click: () => {
      const target = webContents.getFocusedWebContents() ?? (BrowserWindow.getFocusedWindow() ?? primaryWindow)?.webContents;
      if (target && !target.isDestroyed()) run(target);
    },
  };
}

function buildEditMenu(): MenuItemConstructorOptions {
  const platformItems: MenuItemConstructorOptions[] = isMac
    ? [
        editItem(EDIT_COMMANDS.pasteAndMatchStyle),
        editItem(EDIT_COMMANDS.delete),
        editItem(EDIT_COMMANDS.selectAll),
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
      ]
    : [editItem(EDIT_COMMANDS.delete), { type: 'separator' }, editItem(EDIT_COMMANDS.selectAll)];
  return {
    label: 'Edit',
    submenu: [
      editItem(EDIT_COMMANDS.undo),
      editItem(EDIT_COMMANDS.redo),
      { type: 'separator' },
      editItem(EDIT_COMMANDS.cut),
      editItem(EDIT_COMMANDS.copy),
      editItem(EDIT_COMMANDS.paste),
      ...platformItems,
    ],
  };
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    buildEditMenu(),
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function windowIcon(): string | undefined {
  if (process.platform !== 'linux') return undefined; // win: exe icon, mac: bundle icon
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.resolve(__dirname, '../build/icons/256x256.png');
}

function overlayColors(): { color: string; symbolColor: string } {
  // Match the client's default theme (prefers-color-scheme) until the app
  // reports its actual theme over the bridge; values = titleBarColors() in
  // client/src/theme.ts (the TopBar's AppBar background).
  // On Linux the overlay background is fully transparent: the web AppBar (and
  // any modal backdrop) shows through, so that region dims in the same
  // compositor frame as the rest of the page — only the glyphs are native.
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: isLinux ? '#00000000' : dark ? '#151518' : '#f4f4f5',
    symbolColor: dark ? '#e6e6ea' : '#1c1c21',
  };
}

function parseWindowLaunch(value: unknown): AppWindowLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const launch = value as Record<string, unknown>;
  if (
    typeof launch.windowId !== 'string' ||
    !launch.windowId ||
    launch.windowId.length > 200 ||
    typeof launch.title !== 'string' ||
    launch.title.length > 500
  ) {
    return undefined;
  }
  if (launch.context !== undefined) {
    if (!launch.context || typeof launch.context !== 'object') return undefined;
    const context = launch.context as Record<string, unknown>;
    const validList = (items: unknown): items is string[] =>
      Array.isArray(items) &&
      items.length <= 1000 &&
      items.every((item) => typeof item === 'string' && item.length <= 1000);
    if (!validList(context.selected) || !validList(context.namespaces) || typeof context.navCollapsed !== 'boolean') return undefined;
  }
  if (launch.kind === 'tab-transfer') {
    return (launch.surface === 'page' || launch.surface === 'dock') &&
      typeof launch.transferId === 'string' && !!launch.transferId && launch.transferId.length <= 200
      ? (value as AppWindowLaunch)
      : undefined;
  }
  if ((launch.kind !== 'page' && launch.kind !== 'dock') || !launch.tab || typeof launch.tab !== 'object') return undefined;
  const tab = launch.tab as Record<string, unknown>;
  if (launch.kind === 'page') {
    return typeof tab.path === 'string' && tab.path.startsWith('/') && !tab.path.startsWith('//') && tab.path.length <= 8192
      ? (value as AppWindowLaunch)
      : undefined;
  }
  return typeof tab.kind === 'string' && ['terminal', 'node-shell', 'logs'].includes(tab.kind) && typeof tab.title === 'string'
    ? (value as AppWindowLaunch)
    : undefined;
}

function isApplicationLaunch(launch?: AppWindowLaunch): boolean {
  return !launch || launch.kind === 'page' || (launch.kind === 'tab-transfer' && launch.surface === 'page');
}

function createWindow(url: string, launch?: AppWindowLaunch): BrowserWindow {
  const state = loadWindowState();
  const applicationSurface = isApplicationLaunch(launch);
  const isPrimary = applicationSurface && !primaryWindow;
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x === undefined || isPrimary ? state.x : state.x + 28,
    y: state.y === undefined || isPrimary ? state.y : state.y + 28,
    minWidth: 800,
    minHeight: 500,
    title: launch ? `${launch.title} — Kubus` : 'Kubus',
    show: false,
    backgroundColor: overlayColors().color,
    icon: windowIcon(),
    // Frameless look on every platform: the client's TopBar is the titlebar
    // (drag region + env(titlebar-area-*) paddings live in the client CSS).
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    titleBarOverlay: isMac ? true : { ...overlayColors(), height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  managedWindows.add(win);
  if (applicationSurface) applicationWindows.add(win);
  const webContentsId = win.webContents.id;
  if (launch) windowLaunches.set(webContentsId, launch);
  if (isPrimary) primaryWindow = win;
  if (state.maximized && isPrimary) win.maximize();
  // The menu stays installed so its accelerators (zoom, reload, devtools,
  // fullscreen) keep working, but the bar itself is macOS-only chrome.
  if (!isMac) win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('close', () => {
    if (win === primaryWindow) saveWindowState(win);
  });
  win.on('closed', () => {
    managedWindows.delete(win);
    applicationWindows.delete(win);
    routeReadyWindows.delete(win);
    windowLaunches.delete(webContentsId);
    if (win === primaryWindow) {
      // Only another full application renderer can own navigation/deep links.
      primaryWindow = applicationWindows.values().next().value;
    }
  });
  // A reload restarts the SPA; hold routes until it re-registers.
  win.webContents.on('did-start-loading', () => {
    routeReadyWindows.delete(win);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    mainLog('error', `window renderer gone (${details.reason}, exit code ${details.exitCode})`);
  });
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    void shell.openExternal(external);
    return { action: 'deny' };
  });
  // Cmd/Ctrl+W is the OS "close window" accelerator. Hand it to the renderer so
  // it can close the focused dock tab (logs/terminal) first, and only close the
  // whole window when nothing is docked. preventDefault() stops the native menu
  // accelerator from firing (and keeps the key out of the page).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    // Cmd/Ctrl+W closes the focused dock/page tab — never the window.
    if (key === 'w' && !input.alt && !input.shift && (isMac ? input.meta && !input.control : input.control && !input.meta)) {
      event.preventDefault();
      win.webContents.send('kubus:close-tab');
      return;
    }
    // Browser-style page-tab cycling; the payload is true to cycle backwards.
    if (input.control && !input.meta && !input.alt && (key === 'tab' || key === 'pageup' || key === 'pagedown')) {
      event.preventDefault();
      win.webContents.send('kubus:cycle-tab', key === 'tab' ? input.shift : key === 'pageup');
      return;
    }
    if (isMac && input.meta && input.shift && !input.control && !input.alt && (input.code === 'BracketLeft' || input.code === 'BracketRight')) {
      event.preventDefault();
      win.webContents.send('kubus:cycle-tab', input.code === 'BracketLeft');
    }
  });
  void win.loadURL(url);
  return win;
}

ipcMain.on('kubus:close-window', (event) => {
  senderWindow(event)?.close();
});

ipcMain.on('kubus:set-titlebar-overlay', (event, options: unknown) => {
  if (isMac) return;
  const win = senderWindow(event);
  if (!win) return;
  const { color, symbolColor } = (options ?? {}) as { color?: unknown; symbolColor?: unknown };
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return;
  try {
    win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  } catch {
    /* overlay not supported in this environment */
  }
});

// One sync call, at preload time only: the boot snapshot the bridge serves
// getItem from. A sync handler must set returnValue on every path — a missed
// reply parks the renderer main thread forever.
ipcMain.on('kubus:state:get-all', (event) => {
  try {
    event.returnValue = isManagedWindowSender(event) ? { ...loadClientState() } : {};
  } catch {
    event.returnValue = {};
  }
});

// Steady-state writes are fire-and-forget so the renderer never blocks on
// persistence; bursts (fast clicking flips several stores at once) coalesce
// into one disk write.
const STATE_FLUSH_MS = 150;
const STATE_RETRY_MS = 5_000;
let stateFlushTimer: NodeJS.Timeout | undefined;
let pendingClientState: Record<string, string> | undefined;

function scheduleClientStateFlush(state: Record<string, string>, delay = STATE_FLUSH_MS): void {
  pendingClientState = state;
  clientStateCache = state;
  stateFlushTimer ??= setTimeout(() => {
    stateFlushTimer = undefined;
    flushClientState();
  }, delay);
}

function flushClientState(): void {
  if (stateFlushTimer !== undefined) {
    clearTimeout(stateFlushTimer);
    stateFlushTimer = undefined;
  }
  const state = pendingClientState;
  if (!state) return;
  try {
    saveClientState(state);
    pendingClientState = undefined;
  } catch {
    // Disk write failed (full disk, permissions …): keep the state pending
    // and retry with backoff, and tell the renderer so it can mirror the
    // snapshot into browser storage as a fallback.
    for (const win of managedWindows) win.webContents.send('kubus:state:write-failed');
    scheduleClientStateFlush(state, STATE_RETRY_MS);
  }
}

ipcMain.on('kubus:state:set-item', (event, name: unknown, value: unknown) => {
  if (!isManagedWindowSender(event) || typeof name !== 'string' || typeof value !== 'string') return;
  scheduleClientStateFlush({ ...loadClientState(), [name]: value });
  for (const win of managedWindows) {
    if (win.webContents !== event.sender) win.webContents.send('kubus:state:changed', name, value);
  }
});

ipcMain.on('kubus:state:remove-item', (event, name: unknown) => {
  if (!isManagedWindowSender(event) || typeof name !== 'string') return;
  const next = { ...loadClientState() };
  delete next[name];
  scheduleClientStateFlush(next);
  for (const win of managedWindows) {
    if (win.webContents !== event.sender) win.webContents.send('kubus:state:changed', name, null);
  }
});

// The renderer pulls the pending deep link once its route listener is
// attached; from then on links are pushed over kubus:open-route.
ipcMain.handle('kubus:get-pending-route', (event): string | null => {
  const win = senderWindow(event);
  if (!win || !applicationWindows.has(win)) return null;
  // Every full app renderer installs the listener. Remember readiness now so
  // an already-loaded page window can safely become the navigation owner.
  routeReadyWindows.add(win);
  if (!isPrimaryWindowSender(event)) return null;
  const route = pendingRoute ?? null;
  pendingRoute = undefined;
  return route;
});

ipcMain.handle('kubus:get-app-info', (event): AppInfo | undefined => {
  if (!isManagedWindowSender(event)) return undefined;
  const enginePath = process.env.KUBUS_HELM_ENGINE;
  return { name: app.getName(), version: app.getVersion(), helmEngine: !!enginePath && existsSync(enginePath) };
});

ipcMain.handle('kubus:update:state', (event) => isManagedWindowSender(event) ? desktopUpdater?.getState() : undefined);
ipcMain.handle('kubus:update:check', (event) => isManagedWindowSender(event) ? desktopUpdater?.check() : undefined);
ipcMain.handle('kubus:update:download', (event) => isManagedWindowSender(event) ? desktopUpdater?.download() : undefined);
ipcMain.handle('kubus:update:install', (event) => isManagedWindowSender(event) && desktopUpdater?.requestInstall() === true);

ipcMain.on('kubus:window-launch', (event) => {
  event.returnValue = isManagedWindowSender(event) ? windowLaunches.get(event.sender.id) : undefined;
});

ipcMain.on('kubus:open-window', (event, value: unknown) => {
  if (!isManagedWindowSender(event) || !appUrl) return;
  const launch = parseWindowLaunch(value);
  if (launch) createWindow(appUrl, launch);
});

ipcMain.handle('kubus:detach-tab', (event, value: unknown): boolean => {
  if (!isManagedWindowSender(event) || !appUrl) return false;
  const launch = parseWindowLaunch(value);
  if (launch?.kind !== 'tab-transfer') return false;
  const cursor = screen.getCursorScreenPoint();
  const insideWindow = [...managedWindows]
    .filter((win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized())
    .some((win) => {
      const bounds = win.getBounds();
      return cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    });
  if (insideWindow) return false;
  createWindow(appUrl, launch);
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux deliver a deep link to the running instance as an argv
    // entry of the second process.
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    const route = link ? routeFromDeepLink(link) : undefined;
    if (route) {
      openRoute(route);
      return;
    }
    const win = primaryWindow ?? managedWindows.values().next().value;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    // Windows/Linux cold start via a deep link: the URL arrives in our own argv.
    const link = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (link) pendingRoute = routeFromDeepLink(link);
    // The esbuild bundle breaks the server's import.meta.url asset lookup, so
    // point it at the packaged (or repo) helm engine explicitly.
    process.env.KUBUS_HELM_ENGINE ??= app.isPackaged
      ? path.join(process.resourcesPath, 'helm-engine.wasm.gz')
      : path.resolve(__dirname, '../../server/assets/helm-engine.wasm.gz');
    try {
      server = await startServer({
        port: 0,
        openBrowser: false,
        prettyLogs: false,
        staticRoot: app.isPackaged
          ? path.join(process.resourcesPath, 'client')
          : path.resolve(__dirname, '../../client/dist'),
      });
    } catch (err) {
      mainLog('error', 'the embedded server failed to start', err);
      const logPath = mainLogPath();
      dialog.showErrorBox(
        'Kubus failed to start',
        `${err instanceof Error ? err.message : String(err)}${logPath ? `\n\nDetails were written to:\n${logPath}` : ''}`,
      );
      app.quit();
      return;
    }
    // server.url carries the renderer's bearer token. Keep credentials out of
    // the persistent main-process log and the exportable diagnostic buffer.
    mainLog('info', `server listening at ${new URL(server.url).origin}`);
    buildMenu();
    appUrl = server.url;
    createWindow(appUrl);
    const metadata = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { kubusUpdateMode?: string };
    const reason = updateDisabledReason({ packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      store: process.windowsStore === true || metadata.kubusUpdateMode === 'store', appImage: !!process.env.APPIMAGE });
    desktopUpdater = new DesktopUpdater({
      version: app.getVersion(), reason,
      updater: reason ? undefined : electronUpdater.autoUpdater,
      broadcast: (state) => {
        for (const win of managedWindows) {
          if (!win.isDestroyed()) win.webContents.send('kubus:update:changed', state);
        }
      },
      prepareInstall: () => { quittingForUpdate = true; app.quit(); },
      recoverInstall: () => { app.relaunch(); app.exit(0); },
    });
    desktopUpdater.start();
  });

  // The server (and its port-forwards) is tied to the window, so quit
  // everywhere — including macOS — instead of lingering headless.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    desktopUpdater?.stop();
    flushClientState();
    if (!server) return;
    event.preventDefault();
    if (!closing) {
      // Quit can arrive with a window still open (Cmd+Q), or after the last
      // window disappears. Persist bounds before the fallback can bypass close.
      if (primaryWindow && !primaryWindow.isDestroyed()) saveWindowState(primaryWindow);
      mainLog('info', 'closing the embedded server');
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        flushClientState();
        mainLog('warn', `server shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing application exit`);
        // app.quit() would re-enter this handler and wait on the same stalled
        // promise. Exit directly if cleanup cannot finish, e.g. after sleep.
        finishQuit(true);
      }, SHUTDOWN_TIMEOUT_MS);
      closing = (async () => {
        try {
          await server.close();
          if (!timedOut) mainLog('info', 'embedded server closed');
        } catch (err) {
          mainLog('error', 'embedded server shutdown failed', err);
        } finally {
          clearTimeout(timeout);
        }
        if (timedOut) return;
        finishQuit();
      })();
    }
  });
}

function finishQuit(force = false): void {
  server = undefined;
  if (quittingForUpdate) {
    quittingForUpdate = false;
    desktopUpdater!.finishInstall();
  } else if (force) {
    app.exit(0);
  } else {
    app.quit();
  }
}
