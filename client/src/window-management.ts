import type { AppWindowLaunch } from '@kubus/shared';
import { authToken } from './api/http.js';

const LAUNCH_FRAGMENT_KEY = 'launch';
const WINDOW_SCOPE_KEY = 'kubus-window-scope';
const WINDOW_SURFACE_KEY = 'kubus-window-surface';

export type AppWindowSurface = 'app' | 'dock';

type AppWindowRequest =
  | Omit<Extract<AppWindowLaunch, { kind: 'page' }>, 'windowId'>
  | Omit<Extract<AppWindowLaunch, { kind: 'dock' }>, 'windowId'>
  | Omit<Extract<AppWindowLaunch, { kind: 'tab-transfer' }>, 'windowId'>;

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

const boundedString = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const optionalString = (value: unknown, max = 4096): boolean => value === undefined || boundedString(value, max);
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';

function validWindowContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return (
    Array.isArray(context.selected) &&
    context.selected.length <= 1000 &&
    context.selected.every((item) => boundedString(item, 1000)) &&
    Array.isArray(context.namespaces) &&
    context.namespaces.length <= 1000 &&
    context.namespaces.every((item) => boundedString(item, 1000)) &&
    typeof context.navCollapsed === 'boolean'
  );
}

function validDockTab(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  if (!boundedString(tab.title, 500) || !boundedString(tab.ctx, 1000)) return false;
  if (!optionalBoolean(tab.pinned) || !optionalString(tab.color, 100)) return false;
  if (tab.kind === 'terminal') {
    return [tab.namespace, tab.pod, tab.container].every((field) => boundedString(field, 1000));
  }
  if (tab.kind === 'node-shell') return boundedString(tab.node, 1000);
  if (tab.kind !== 'logs' || !boundedString(tab.namespace, 1000)) return false;
  if (!Array.isArray(tab.pods) || tab.pods.length > 1000 || !tab.pods.every((pod) => boundedString(pod, 1000))) return false;
  return (
    optionalString(tab.container, 1000) &&
    optionalBoolean(tab.follow) &&
    optionalBoolean(tab.previous) &&
    (tab.tailLines === undefined || (typeof tab.tailLines === 'number' && Number.isFinite(tab.tailLines))) &&
    (tab.sinceSeconds === undefined || (typeof tab.sinceSeconds === 'number' && Number.isFinite(tab.sinceSeconds)))
  );
}

export function isAppWindowLaunch(value: unknown): value is AppWindowLaunch {
  if (!value || typeof value !== 'object') return false;
  const launch = value as Record<string, unknown>;
  if (!boundedString(launch.windowId, 200) || !launch.windowId || !boundedString(launch.title, 500)) return false;
  if (!validWindowContext(launch.context)) return false;
  if (launch.kind === 'tab-transfer') {
    return (
      (launch.surface === 'page' || launch.surface === 'dock') &&
      boundedString(launch.transferId, 200) &&
      !!launch.transferId
    );
  }
  if (!launch.tab || typeof launch.tab !== 'object') return false;
  if (launch.kind === 'dock') return validDockTab(launch.tab);
  if (launch.kind !== 'page') return false;
  const tab = launch.tab as Record<string, unknown>;
  return (
    boundedString(tab.path, 8192) &&
    tab.path.startsWith('/') &&
    !tab.path.startsWith('//') &&
    optionalString(tab.customTitle, 200) &&
    optionalString(tab.color, 100) &&
    optionalBoolean(tab.pinned) &&
    (tab.pendingSavedView === undefined || (!!tab.pendingSavedView && typeof tab.pendingSavedView === 'object'))
  );
}

export function encodeAppWindowLaunch(launch: AppWindowLaunch): string {
  return encodeBase64Url(JSON.stringify(launch));
}

export function decodeAppWindowLaunch(value: string): AppWindowLaunch | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(value));
    return isAppWindowLaunch(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function launchFromLocation(): AppWindowLaunch | undefined {
  const fragment = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash);
  const encoded = fragment.get(LAUNCH_FRAGMENT_KEY);
  return encoded ? decodeAppWindowLaunch(encoded) : undefined;
}

/** Read without consuming so stores can choose a per-window persistence scope during module initialization. */
export function peekAppWindowLaunch(): AppWindowLaunch | undefined {
  return window.kubusDesktop?.windowLaunch ?? launchFromLocation();
}

/** Stable layout-storage scope: secondary windows never overwrite the primary window's tab list. */
export function windowScopeId(): string {
  const launchId = peekAppWindowLaunch()?.windowId;
  if (launchId) {
    sessionStorage.setItem(WINDOW_SCOPE_KEY, launchId);
    return launchId;
  }
  return sessionStorage.getItem(WINDOW_SCOPE_KEY) ?? 'main';
}

/** The renderer shell is sticky across reloads after the one-shot launch is consumed. */
export function appWindowSurface(): AppWindowSurface {
  const launch = peekAppWindowLaunch();
  if (launch) {
    const surface = launch.kind === 'dock' || (launch.kind === 'tab-transfer' && launch.surface === 'dock')
      ? 'dock'
      : 'app';
    sessionStorage.setItem(WINDOW_SURFACE_KEY, surface);
    return surface;
  }
  return sessionStorage.getItem(WINDOW_SURFACE_KEY) === 'dock' ? 'dock' : 'app';
}

/** Consume the one-shot browser fragment. Electron retains its launch across reloads. */
export function consumeAppWindowLaunch(): AppWindowLaunch | undefined {
  const launch = peekAppWindowLaunch();
  if (!launch || window.kubusDesktop?.windowLaunch) return launch;
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  fragment.delete(LAUNCH_FRAGMENT_KEY);
  url.hash = fragment.toString();
  window.history.replaceState({}, '', url.toString());
  return launch;
}

/** Ask Electron for a native window, with a same-origin browser fallback. */
export function openAppWindow(request: AppWindowRequest): boolean {
  const launch = { ...request, windowId: randomId() } as AppWindowLaunch;
  if (window.kubusDesktop) {
    window.kubusDesktop.openWindow(launch);
    return true;
  }

  const url = new URL(window.location.href);
  url.pathname = '/';
  url.search = '';
  const token = authToken();
  if (token) url.searchParams.set('token', token);
  const fragment = new URLSearchParams();
  fragment.set(LAUNCH_FRAGMENT_KEY, encodeAppWindowLaunch(launch));
  url.hash = fragment.toString();
  // Supplying the `noopener` feature makes standards-compliant browsers return
  // null even when the popup was created. We need the return value to distinguish
  // a blocked popup from a successful handoff, so sever the opener explicitly.
  const opened = window.open(url.toString(), '_blank');
  if (!opened) return false;
  opened.opener = null;
  return true;
}

/** Native cursor bounds avoid accidental detach while a tab is dropped inside any Kubus window. */
export async function detachTabWindow(request: Omit<Extract<AppWindowLaunch, { kind: 'tab-transfer' }>, 'windowId'>): Promise<boolean> {
  const launch = { ...request, windowId: randomId() } as Extract<AppWindowLaunch, { kind: 'tab-transfer' }>;
  if (window.kubusDesktop) {
    return window.kubusDesktop.detachTab(launch);
  }
  return openAppWindow(request);
}
