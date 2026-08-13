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
  type MenuItemConstructorOptions,
} from 'electron';
import fixPath from 'fix-path';
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
const isLinux = process.platform === 'linux';

// Must match the client TopBar height: its toolbar doubles as the titlebar.
const TITLEBAR_HEIGHT = 52;
const UPDATE_MANIFEST_URL = 'https://kubus-app.dev/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

let primaryWindow: BrowserWindow | undefined;
let appUrl: string | undefined;
const managedWindows = new Set<BrowserWindow>();
const windowLaunches = new Map<number, AppWindowLaunch>();
let server: RunningServer | undefined;
let closing: Promise<void> | undefined;
let updateCheck: Promise<UpdateCheckResult> | undefined;

// ---- kubus:// deep links -------------------------------------------------
// The client is served from a random localhost port, so shareable links use
// the kubus:// scheme and carry only the in-app route; the renderer's router
// resolves it against whatever origin this instance runs on.

const PROTOCOL = 'kubus';
let pendingRoute: string | undefined;
// True once the renderer has called kubus:get-pending-route, i.e. its route
// listener is attached. Pushing before that (did-finish-load fires before the
// SPA mounts) would drop the link on cold start.
let rendererRouteReady = false;

/** kubus://r/apps/v1/deployments?sel=… → "/r/apps/v1/deployments?sel=…". */
function routeFromDeepLink(raw: string): string | undefined {
  if (!raw.startsWith(`${PROTOCOL}://`)) return undefined;
  const rest = raw.slice(`${PROTOCOL}://`.length);
  const route = rest.startsWith('/') ? rest : `/${rest}`;
  // Reject protocol-relative smuggling — only same-app routes may pass.
  return route.startsWith('//') ? undefined : route;
}

function openRoute(route: string): void {
  const win = primaryWindow ?? managedWindows.values().next().value;
  if (win && rendererRouteReady) {
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

interface UpdateManifest {
  version?: unknown;
  releaseName?: unknown;
  releaseUrl?: unknown;
  publishedAt?: unknown;
}

type UpdateCheckResult =
  | {
      available: true;
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      releaseUrl: string;
      publishedAt?: string;
    }
  | {
      available: false;
      currentVersion: string;
      latestVersion?: string;
      reason?: string;
    };

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

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
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

function versionParts(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  const [nextMajor, nextMinor, nextPatch] = next;
  const [installedMajor, installedMinor, installedPatch] = installed;
  const pairs = [
    [nextMajor, installedMajor],
    [nextMinor, installedMinor],
    [nextPatch, installedPatch],
  ] as const;
  for (const [nextPart, installedPart] of pairs) {
    if (nextPart > installedPart) return true;
    if (nextPart < installedPart) return false;
  }
  return false;
}

function releaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
    if (!url.pathname.startsWith('/FloSch62/Kubus/releases/')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const url = new URL(UPDATE_MANIFEST_URL);
    if (force) url.searchParams.set('t', String(Date.now()));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Kubus/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (response.status === 404) return { available: false, currentVersion, reason: 'no-release' };
    if (!response.ok) return { available: false, currentVersion, reason: `manifest-${response.status}` };

    const manifest = (await response.json()) as UpdateManifest;
    const version = typeof manifest.version === 'string' ? manifest.version : undefined;
    if (!version) return { available: false, currentVersion, reason: 'missing-version' };

    const latestVersion = normalizeVersion(version);
    if (!isNewerVersion(latestVersion, currentVersion)) return { available: false, currentVersion, latestVersion };

    const downloadUrl = releaseUrl(manifest.releaseUrl);
    if (!downloadUrl) return { available: false, currentVersion, latestVersion, reason: 'missing-release-url' };

    return {
      available: true,
      currentVersion,
      latestVersion,
      releaseName: typeof manifest.releaseName === 'string' && manifest.releaseName ? manifest.releaseName : undefined,
      releaseUrl: downloadUrl,
      publishedAt: typeof manifest.publishedAt === 'string' ? manifest.publishedAt : undefined,
    };
  } catch (err) {
    return {
      available: false,
      currentVersion,
      reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timeout);
  }
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

function createWindow(url: string, launch?: AppWindowLaunch): BrowserWindow {
  const state = loadWindowState();
  const isPrimary = !primaryWindow;
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
    windowLaunches.delete(webContentsId);
    if (win === primaryWindow) {
      primaryWindow = managedWindows.values().next().value;
      // Existing renderers registered their deep-link listener during boot.
      rendererRouteReady = !!primaryWindow;
    }
  });
  // A reload restarts the SPA; hold routes until it re-registers.
  win.webContents.on('did-start-loading', () => {
    if (win === primaryWindow) rendererRouteReady = false;
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
  if (!isPrimaryWindowSender(event)) return null;
  rendererRouteReady = true;
  const route = pendingRoute ?? null;
  pendingRoute = undefined;
  return route;
});

ipcMain.handle('kubus:get-app-info', (event): AppInfo | undefined => {
  if (!isManagedWindowSender(event)) return undefined;
  const enginePath = process.env.KUBUS_HELM_ENGINE;
  return { name: app.getName(), version: app.getVersion(), helmEngine: !!enginePath && existsSync(enginePath) };
});

ipcMain.handle('kubus:check-for-update', async (event, options?: { force?: unknown }): Promise<UpdateCheckResult> => {
  if (!isManagedWindowSender(event)) {
    return { available: false, currentVersion: app.getVersion(), reason: 'invalid-sender' };
  }
  if (options?.force === true) updateCheck = checkForUpdate(true);
  updateCheck ??= checkForUpdate();
  return updateCheck;
});

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
    const win = primaryWindow ?? managedWindows.values().next().value;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Windows/Linux deliver a deep link to the running instance as an argv
    // entry of the second process.
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    const route = link ? routeFromDeepLink(link) : undefined;
    if (route) openRoute(route);
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
  });

  // The server (and its port-forwards) is tied to the window, so quit
  // everywhere — including macOS — instead of lingering headless.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    flushClientState();
    if (!server) return;
    if (!closing) {
      closing = server.close().catch(() => undefined);
      void closing.then(() => {
        server = undefined;
        app.quit();
      });
    }
    event.preventDefault();
  });
}
