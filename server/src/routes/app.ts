import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppInfo } from '@kubus/shared';
import type { AppContext } from '../app.js';
import { engineAvailable } from '../helm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function appInfo(): AppInfo {
  return { name: 'Kubus', version: APP_VERSION, helmEngine: engineAvailable() };
}

export function registerAppRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/api/app/info', async () => appInfo());
}
