import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, BuildConfig, Screen, Utils } from 'electrobun/main';
import fixPath from 'fix-path';
import { startServer, type RunningServer } from '@kubus/server';
import type { AppWindowLaunch, UpdateCheckResult } from '@kubus/shared';
import { version } from '../package.json';
import type { DesktopRPC } from './rpc.js';
import { checkForUpdate, isApplicationLaunch, parseWindowLaunch, routeFromDeepLink } from './policy.js';
import { ClientState, migrateClientState } from './state.js';
import { legacyClientStatePath, userDataPath } from './paths.js';
import { registerProtocol } from './protocol.js';
import { initMainLog, installCrashCapture, mainLog, mainLogPath } from './main-log.js';

type Window = BrowserWindow<ReturnType<typeof BrowserView.defineRPC<DesktopRPC>>>;
const windows = new Set<Window>();
const applications = new Set<Window>();
const routeReady = new Set<Window>();
const isMac = process.platform === 'darwin';
const userData = userDataPath();
// Hutch launches the main process from the bundle's MacOS/bin directory.
const resources = path.resolve('../Resources/app');
const windowStateFile = path.join(userData, 'window-state.json');
let primary: Window | undefined;
let focused: Window | undefined;
let server: RunningServer | undefined;
let pendingRoute: string | undefined;
let update: Promise<UpdateCheckResult> | undefined;
let closing: Promise<void> | undefined;
let quitReady = false;
let preload: string;
let state: ClientState;

function activate(link?: string): void {
  const route = link ? routeFromDeepLink(link) : undefined;
  if (route) {
    if (primary && routeReady.has(primary)) primary.webview.rpc?.send.openRoute(route);
    else pendingRoute = route;
    if (!primary && server) createWindow();
  }
  const target = primary ?? focused ?? windows.values().next().value;
  if (target?.isMinimized()) target.unminimize();
  target?.activate();
}

function loadFrame(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try {
    const frame = JSON.parse(readFileSync(windowStateFile, 'utf8'));
    if (![frame.width, frame.height].every((value) => Number.isFinite(value) && value >= 500 && value <= 16_384)) throw new Error('Invalid frame');
    const visible = Screen.getAllDisplays().some((display) => {
      const b = display.workArea;
      return frame.x < b.x + b.width && frame.x + frame.width > b.x && frame.y < b.y + b.height && frame.y + frame.height > b.y;
    });
    return { width: frame.width, height: frame.height, ...(visible ? { x: frame.x, y: frame.y } : {}), maximized: frame.maximized === true };
  } catch { return { width: 1440, height: 900 }; }
}

function createWindow(launch?: AppWindowLaunch): Window {
  if (!server) throw new Error('The embedded server is not ready');
  let win: Window;
  const rpc = BrowserView.defineRPC<DesktopRPC>({
    maxRequestTime: 15_000,
    handlers: {
      requests: {
        bootstrap: () => ({ platform: process.platform, state: state.snapshot(), launch }),
        getAppInfo: () => ({ name: 'Kubus', version, helmEngine: existsSync(process.env.KUBUS_HELM_ENGINE!) }),
        checkForUpdate: (options) => {
          if (options?.force === true) update = checkForUpdate(version, true);
          return update ??= checkForUpdate(version);
        },
        getPendingRoute: () => {
          if (!applications.has(win)) return null;
          routeReady.add(win);
          if (win !== primary) return null;
          const route = pendingRoute ?? null;
          pendingRoute = undefined;
          return route;
        },
        detachTab: (value) => {
          const parsed = parseWindowLaunch(value);
          if (parsed?.kind !== 'tab-transfer' || closing) return false;
          const cursor = Screen.getCursorScreenPoint();
          if ([...windows].some((other) => {
            if (!other.isVisible() || other.isMinimized()) return false;
            const b = other.getFrame();
            return cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
          })) return false;
          createWindow(parsed);
          return true;
        },
      },
      messages: {
        stateChanged: ({ name, value }) => {
          if (typeof name !== 'string' || (value !== null && typeof value !== 'string')) return;
          state.change(name, value);
          for (const other of windows) if (other !== win) other.webview.rpc?.send.stateChanged({ name, value });
        },
        openWindow: (value) => { const parsed = parseWindowLaunch(value); if (parsed && !closing) createWindow(parsed); },
        windowAction: (action) => performAction(action, win),
        closeWindow: () => win.requestClose(),
        minimizeWindow: () => win.minimize(),
        toggleMaximize: () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); },
        openExternal: (url) => openExternal(url),
      },
    },
  });
  const frame = loadFrame();
  win = new BrowserWindow({
    title: launch ? `${launch.title} — Kubus` : 'Kubus',
    url: server.url,
    preload,
    rpc,
    renderer: 'native',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightOffset: { x: 16, y: 18 },
    frame,
    navigationRules: JSON.stringify(['^*', `${new URL(server.url).origin}/*`]),
  });
  windows.add(win);
  focused = win;
  if (isApplicationLaunch(launch)) { applications.add(win); primary ??= win; }
  let normalFrame = win.getFrame();
  if (frame.maximized && win === primary) win.maximize();
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const saveFrame = () => {
    clearTimeout(frameTimer);
    frameTimer = undefined;
    if (win !== primary) return;
    const maximized = win.isMaximized();
    if (!maximized && !win.isFullScreen()) normalFrame = win.getFrame();
    try { writeFileSync(windowStateFile, JSON.stringify({ ...normalFrame, maximized }), { mode: 0o600 }); }
    catch (error) { mainLog('warn', 'could not save window bounds', error); }
  };
  // Native queries synchronously cross onto GTK's UI thread. Keep both those
  // round trips and disk writes out of the stream of move/resize events.
  const scheduleFrameSave = () => {
    if (win !== primary) return;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(saveFrame, 200);
  };
  win.on('resize', scheduleFrameSave);
  win.on('move', scheduleFrameSave);
  win.on('will-close', saveFrame);
  win.on('focus', () => { focused = win; });
  win.on('close', () => {
    clearTimeout(frameTimer);
    windows.delete(win); applications.delete(win); routeReady.delete(win);
    if (primary === win) primary = applications.values().next().value;
    if (focused === win) focused = primary ?? windows.values().next().value;
    if (!windows.size) void shutdown();
  });
  win.webview.on('will-navigate', () => routeReady.delete(win));
  return win;
}

function openExternal(value: unknown): void {
  if (typeof value !== 'string') return;
  try { if (['https:', 'http:', 'mailto:'].includes(new URL(value).protocol)) Utils.openExternal(value); }
  catch { /* Invalid external link. */ }
}

function buildMenu(): void {
  ApplicationMenu.setApplicationMenu([
    ...(isMac ? [{ label: 'Kubus', submenu: [{ label: 'About Kubus', role: 'about' }, { type: 'separator' as const }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' }, { type: 'separator' as const }, { label: 'Quit Kubus', action: 'quit', accelerator: 'Command+q' }] }] : []),
    { label: 'File', submenu: [{ label: 'Close Tab', action: 'close-tab', accelerator: isMac ? 'Command+w' : 'Control+w' }, { label: 'Close Window', action: 'close-window', accelerator: isMac ? 'Command+Shift+w' : 'Control+Shift+w' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload', action: 'reload', accelerator: isMac ? 'Command+r' : 'Control+r' }, { label: 'Zoom In', action: 'zoom-in' }, { label: 'Zoom Out', action: 'zoom-out' }, { label: 'Actual Size', action: 'zoom-reset' }, { label: 'Developer Tools', action: 'devtools', accelerator: isMac ? 'Command+Alt+i' : 'Control+Shift+i' }, { label: 'Full Screen', action: 'fullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Previous Tab', action: 'previous-tab', accelerator: isMac ? 'Command+Shift+[' : 'Control+PageUp' }, { label: 'Next Tab', action: 'next-tab', accelerator: isMac ? 'Command+Shift+]' : 'Control+PageDown' }] },
  ]);
  Electrobun.events.on('application-menu-clicked', (event) => performAction(event.data.action, focused ?? primary));
}

function performAction(action: string, win?: Window): void {
    switch (action) {
      case 'quit': void shutdown(); break;
      case 'close-tab': win?.webview.rpc?.send.closeTab(); break;
      case 'close-window': win?.requestClose(); break;
      case 'previous-tab': win?.webview.rpc?.send.cycleTab(true); break;
      case 'next-tab': win?.webview.rpc?.send.cycleTab(false); break;
      case 'reload': win?.webview.executeJavascript('location.reload()'); break;
      case 'devtools': win?.webview.openDevTools(); break;
      case 'zoom-in': if (win) win.setPageZoom(Math.min(3, win.getPageZoom() + 0.1)); break;
      case 'zoom-out': if (win) win.setPageZoom(Math.max(0.5, win.getPageZoom() - 0.1)); break;
      case 'zoom-reset': win?.setPageZoom(1); break;
      case 'fullscreen': if (win) win.setFullScreen(!win.isFullScreen()); break;
    }
}

function shutdown(): Promise<void> {
  return closing ??= (async () => {
    state?.flush(false);
    const timer = setTimeout(() => {
      state?.flush(false);
      mainLog('warn', 'server shutdown timed out after 5000ms; forcing application exit');
      quitReady = true;
      Utils.quit();
    }, 5000);
    try {
      mainLog('info', 'closing the embedded server');
      await server?.close();
      instanceChannel.postMessage({ type: 'shutdown' });
      mainLog('info', 'embedded server closed');
    } catch (error) { mainLog('error', 'embedded server shutdown failed', error); }
    finally {
      clearTimeout(timer);
      state.flush(false);
      quitReady = true;
      Utils.quit();
    }
  })();
}

Electrobun.events.on('before-quit', (event) => {
  if (quitReady) return;
  event.response = { allow: false };
  void shutdown();
});
Electrobun.events.on('open-url', (event) => activate(event.data.url));
Electrobun.events.on('reopen', () => { if (!primary && server && !closing) createWindow(); activate(); });
// Popup attempts never become privileged application windows.
Electrobun.events.on('new-window-open', (event) => {
  const detail = event.data.detail;
  openExternal(typeof detail === 'string' ? detail : detail.url);
});
const instanceChannel = new BroadcastChannel('kubus-instance');
instanceChannel.onmessage = (event: MessageEvent<{ type: string; link?: string }>) => {
  if (event.data.type === 'activate') activate(event.data.link);
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

async function start(): Promise<void> {
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  initMainLog(userData);
  installCrashCapture();
  const clientStateFile = path.join(userData, 'client-state.json');
  try { migrateClientState(clientStateFile, legacyClientStatePath()); }
  catch (error) { mainLog('warn', 'could not import legacy client state', error); }
  state = new ClientState(clientStateFile, (error) => {
    mainLog('error', 'could not persist client state; retrying', error);
    for (const win of windows) win.webview.rpc?.send.stateWriteFailed();
  });
  fixPath();
  mainLog('info', `Kubus ${version} starting on ${process.platform}/${process.arch} (Electrobun, Bun ${process.versions.bun})`);
  const link = process.env.KUBUS_DEEP_LINK;
  if (link) pendingRoute = routeFromDeepLink(link);
  process.env.KUBUS_HELM_ENGINE ??= path.join(resources, 'helm-engine.wasm.gz');
  preload = readFileSync(path.join(resources, 'preload.js'), 'utf8');
  server = await startServer({ port: 0, openBrowser: false, prettyLogs: false, staticRoot: path.join(resources, 'client') });
  mainLog('info', `server listening at ${new URL(server.url).origin}`);
  if ((await BuildConfig.get()).isPackaged && !process.env.KUBUS_DESKTOP_DATA) {
    try { registerProtocol(path.resolve(process.platform === 'win32' ? 'kubus-link.exe' : 'kubus-link'), path.join(resources, 'icon.png')); }
    catch (error) { mainLog('warn', 'could not register kubus links', error); }
  }
  buildMenu();
  createWindow();
  instanceChannel.postMessage({ type: 'ready' });
}
void start().catch(async (error: unknown) => {
  mainLog('error', 'desktop startup failed', error);
  await Utils.showMessageBox({ type: 'error', title: 'Kubus failed to start', message: String(error), detail: `Details: ${mainLogPath() ?? 'unavailable'}` });
  await shutdown();
});
