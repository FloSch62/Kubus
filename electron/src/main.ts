import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import fixPath from 'fix-path';
import { startServer, type RunningServer } from '@kubus/server';

// GUI apps on macOS/Linux don't inherit the shell PATH; kubeconfig exec
// plugins (aws, gke-gcloud-auth-plugin, kubelogin, ...) need it.
fixPath();

// Without this the Linux WM_CLASS becomes the package.json name
// ("@kubus/electron") and never matches the .desktop StartupWMClass,
// leaving the window without taskbar/dock icon.
app.setName('Kubus');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// Must match the client TopBar height: its toolbar doubles as the titlebar.
const TITLEBAR_HEIGHT = 52;
const UPDATE_MANIFEST_URL = 'https://kubus-app.dev/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

let mainWindow: BrowserWindow | undefined;
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
  const win = mainWindow;
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

function isMainWindowSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents;
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

function createWindow(url: string): void {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 500,
    title: 'Kubus',
    show: false,
    icon: windowIcon(),
    // Frameless look on every platform: the client's TopBar is the titlebar
    // (drag region + env(titlebar-area-*) paddings live in the client CSS).
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    titleBarOverlay: isMac ? true : { ...overlayColors(), height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (state.maximized) mainWindow.maximize();
  // The menu stays installed so its accelerators (zoom, reload, devtools,
  // fullscreen) keep working, but the bar itself is macOS-only chrome.
  if (!isMac) mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => {
    if (mainWindow) saveWindowState(mainWindow);
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    rendererRouteReady = false;
  });
  // A reload restarts the SPA; hold routes until it re-registers.
  mainWindow.webContents.on('did-start-loading', () => {
    rendererRouteReady = false;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: external }) => {
    void shell.openExternal(external);
    return { action: 'deny' };
  });
  // Cmd/Ctrl+W is the OS "close window" accelerator. Hand it to the renderer so
  // it can close the focused dock tab (logs/terminal) first, and only close the
  // whole window when nothing is docked. preventDefault() stops the native menu
  // accelerator from firing (and keeps the key out of the page).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    // Cmd/Ctrl+W closes the focused dock/page tab — never the window.
    if (key === 'w' && !input.alt && !input.shift && (isMac ? input.meta && !input.control : input.control && !input.meta)) {
      event.preventDefault();
      mainWindow?.webContents.send('kubus:close-tab');
      return;
    }
    // Browser-style page-tab cycling; the payload is true to cycle backwards.
    if (input.control && !input.meta && !input.alt && (key === 'tab' || key === 'pageup' || key === 'pagedown')) {
      event.preventDefault();
      mainWindow?.webContents.send('kubus:cycle-tab', key === 'tab' ? input.shift : key === 'pageup');
      return;
    }
    if (isMac && input.meta && input.shift && !input.control && !input.alt && (input.code === 'BracketLeft' || input.code === 'BracketRight')) {
      event.preventDefault();
      mainWindow?.webContents.send('kubus:cycle-tab', input.code === 'BracketLeft');
    }
  });
  void mainWindow.loadURL(url);
}

ipcMain.on('kubus:close-window', (event) => {
  if (!isMainWindowSender(event)) return;
  mainWindow?.close();
});

ipcMain.on('kubus:set-titlebar-overlay', (event, options: unknown) => {
  if (isMac || !isMainWindowSender(event)) return;
  const win = mainWindow;
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
    event.returnValue = isMainWindowSender(event) ? { ...loadClientState() } : {};
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
    mainWindow?.webContents.send('kubus:state:write-failed');
    scheduleClientStateFlush(state, STATE_RETRY_MS);
  }
}

ipcMain.on('kubus:state:set-item', (event, name: unknown, value: unknown) => {
  if (!isMainWindowSender(event) || typeof name !== 'string' || typeof value !== 'string') return;
  scheduleClientStateFlush({ ...loadClientState(), [name]: value });
});

ipcMain.on('kubus:state:remove-item', (event, name: unknown) => {
  if (!isMainWindowSender(event) || typeof name !== 'string') return;
  const next = { ...loadClientState() };
  delete next[name];
  scheduleClientStateFlush(next);
});

// The renderer pulls the pending deep link once its route listener is
// attached; from then on links are pushed over kubus:open-route.
ipcMain.handle('kubus:get-pending-route', (event): string | null => {
  if (!isMainWindowSender(event)) return null;
  rendererRouteReady = true;
  const route = pendingRoute ?? null;
  pendingRoute = undefined;
  return route;
});

ipcMain.handle('kubus:get-app-info', (event): AppInfo | undefined => {
  if (!isMainWindowSender(event)) return undefined;
  const enginePath = process.env.KUBUS_HELM_ENGINE;
  return { name: app.getName(), version: app.getVersion(), helmEngine: !!enginePath && existsSync(enginePath) };
});

ipcMain.handle('kubus:check-for-update', async (event, options?: { force?: unknown }): Promise<UpdateCheckResult> => {
  if (!isMainWindowSender(event)) {
    return { available: false, currentVersion: app.getVersion(), reason: 'invalid-sender' };
  }
  if (options?.force === true) updateCheck = checkForUpdate(true);
  updateCheck ??= checkForUpdate();
  return updateCheck;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
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
      console.error('failed to start kubus server', err);
      app.quit();
      return;
    }
    buildMenu();
    createWindow(server.url);
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
