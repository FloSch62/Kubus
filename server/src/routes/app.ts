import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppInfo, UpdateCheckResult } from '@kubus/shared';
import type { AppContext } from '../app.js';

const UPDATE_MANIFEST_URL = 'https://github.com/FloSch62/Kubus/releases/latest/download/latest.json';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

interface UpdateManifest {
  version?: unknown;
  releaseName?: unknown;
  releaseUrl?: unknown;
  publishedAt?: unknown;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let updateCheck: Promise<UpdateCheckResult> | undefined;

function packageVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../../package.json'),
    path.resolve(__dirname, '../../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* Try the next plausible package path. */
    }
  }
  return '0.0.0';
}

const APP_VERSION = packageVersion();

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

function appInfo(): AppInfo {
  return { name: 'Kubus', version: APP_VERSION };
}

async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const currentVersion = appInfo().version;
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

export function registerAppRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/api/app/info', async () => appInfo());
  app.get<{ Querystring: { force?: string } }>('/api/app/update-check', async (req) => {
    if (req.query.force === 'true') updateCheck = checkForUpdate(true);
    updateCheck ??= checkForUpdate();
    return updateCheck;
  });
}
