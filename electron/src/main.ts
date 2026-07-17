import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
const UPDATE_MANIFEST_URL = 'https://flosch62.github.io/Kubus/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

let mainWindow: BrowserWindow | undefined;
let server: RunningServer | undefined;
let closing: Promise<void> | undefined;
let updateCheck: Promise<UpdateCheckResult> | undefined;

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
    if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'w' || input.alt || input.shift) return;
    const closeChord = isMac ? input.meta && !input.control : input.control && !input.meta;
    if (!closeChord) return;
    event.preventDefault();
    mainWindow?.webContents.send('kubus:close-tab');
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

ipcMain.on('kubus:state:get-item', (event, name: unknown) => {
  event.returnValue = isMainWindowSender(event) && typeof name === 'string' ? (loadClientState()[name] ?? null) : null;
});

ipcMain.on('kubus:state:set-item', (event, name: unknown, value: unknown) => {
  if (!isMainWindowSender(event) || typeof name !== 'string' || typeof value !== 'string') {
    event.returnValue = false;
    return;
  }
  try {
    saveClientState({ ...loadClientState(), [name]: value });
    event.returnValue = true;
  } catch {
    event.returnValue = false;
  }
});

ipcMain.on('kubus:state:remove-item', (event, name: unknown) => {
  if (!isMainWindowSender(event) || typeof name !== 'string') {
    event.returnValue = false;
    return;
  }
  try {
    const next = { ...loadClientState() };
    delete next[name];
    saveClientState(next);
    event.returnValue = true;
  } catch {
    event.returnValue = false;
  }
});

ipcMain.handle('kubus:get-app-info', (event): AppInfo | undefined => {
  if (!isMainWindowSender(event)) return undefined;
  return { name: app.getName(), version: app.getVersion() };
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
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
