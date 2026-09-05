import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..');

// Off the dev (3199/3001) and verify (3299) ports so a running dev instance
// never collides with the e2e server.
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux';
const bundle = process.platform === 'darwin' ? 'Kubus-dev.app/Contents/MacOS' : 'Kubus-dev/bin';
const runtime = process.env.KUBUS_E2E_RUNTIME === 'bun'
  ? path.join(repoRoot, 'desktop/build', `dev-${platform}-${process.arch}`, bundle, process.platform === 'win32' ? 'bun.exe' : 'bun')
  : 'node';
const port = Number(process.env.KUBUS_E2E_PORT ?? 3399);

export default defineConfig({
  testDir: './e2e/specs',
  outputDir: './e2e/.results',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The suite drives one shared server instance whose state (settings,
  // kubeconfig edits, port-forwards) is global — serialize to stay deterministic.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // System Chrome: present on dev machines and GitHub ubuntu runners, so no
    // browser download is needed. Override via PLAYWRIGHT_CHANNEL=chromium
    // after `playwright install chromium` if Chrome is unavailable.
    browserName: process.env.PLAYWRIGHT_BROWSER === 'webkit' ? 'webkit' : 'chromium',
    channel: process.env.PLAYWRIGHT_BROWSER === 'webkit' ? undefined : process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // start-server.mjs seeds isolated state (kubeconfig, XDG config dir),
    // then boots server/dist in-process.
    command: process.env.KUBUS_E2E_RUNTIME === 'bun'
      ? `node "${path.join(testsDir, 'e2e/build-bun-server.mjs')}" && "${runtime}" "${path.join(testsDir, 'e2e/.state/start-server.mjs')}"`
      : `node "${path.join(testsDir, 'e2e/start-server.mjs')}"`,
    cwd: repoRoot, // the server serves client/dist relative to cwd
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      // Fixes the API token to `dev` (KUBUS_DEV only applies outside production).
      KUBUS_DEV: '1',
      KUBUS_NO_OPEN: '1',
      KUBUS_E2E_PORT: String(port),
    },
  },
});
