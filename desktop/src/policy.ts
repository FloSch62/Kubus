import type { AppWindowLaunch, UpdateCheckResult } from '@kubus/shared';
const UPDATE_MANIFEST_URL = 'https://kubus-app.dev/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
interface UpdateManifest { version?: unknown; releaseName?: unknown; releaseUrl?: unknown; publishedAt?: unknown; }

export function routeFromDeepLink(raw: string): string | undefined {
  if (!raw.startsWith(`kubus://`)) return undefined;
  const rest = raw.slice(`kubus://`.length);
  const route = rest.startsWith('/') ? rest : `/${rest}`;
  // Reject protocol-relative smuggling — only same-app routes may pass.
  return route.startsWith('//') ? undefined : route;
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

export async function checkForUpdate(currentVersion: string, force = false): Promise<UpdateCheckResult> {
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

export function parseWindowLaunch(value: unknown): AppWindowLaunch | undefined {
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

export function isApplicationLaunch(launch?: AppWindowLaunch): boolean {
  return !launch || launch.kind === 'page' || (launch.kind === 'tab-transfer' && launch.surface === 'page');
}
