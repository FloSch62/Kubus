// Playwright webServer entry: seed isolated state, then boot the real server
// in-process so Playwright's process management applies to it directly.
// Doing the seeding here (not in global-setup) keeps it correct regardless of
// the order Playwright starts the web server vs. global setup.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ensureKubeconfig, kubeconfigPath, repoRoot, stateDir } from './helpers/cluster.mjs';

const port = process.env.KUBUS_E2E_PORT ?? '3399';

ensureKubeconfig();

// Fresh settings every run: a previous run's persisted settings (kubeconfig
// path overrides, tunnels, helm repos) must not leak into this one.
const configHome = path.join(stateDir, 'config');
fs.rmSync(configHome, { recursive: true, force: true });
fs.mkdirSync(configHome, { recursive: true });
process.env.XDG_CONFIG_HOME = configHome;

const entry = path.join(repoRoot, 'server', 'dist', 'index.js');
if (!fs.existsSync(entry)) {
  console.error('e2e: server/dist/index.js missing — run `pnpm build` first.');
  process.exit(1);
}

process.argv = [
  process.argv[0],
  entry,
  '--port',
  port,
  '--kubeconfig',
  kubeconfigPath,
  '--no-open',
];
await import(pathToFileURL(entry).href);
