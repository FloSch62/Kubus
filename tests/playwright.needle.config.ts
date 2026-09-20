import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

if (!existsSync(new URL('../client/public/needle/needle3.cact', import.meta.url))) {
  throw new Error('Run pnpm setup:needle before the real WASM browser trial.');
}

export default defineConfig({
  testDir: './needle',
  outputDir: './e2e/.results/needle',
  workers: 1,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:3401',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: process.env.KUBUS_NEEDLE_DEV === '1'
      ? 'pnpm --filter @kubus/client dev --host 127.0.0.1 --port 3401 --strictPort'
      : 'pnpm --filter @kubus/client build && pnpm --filter @kubus/client exec vite preview --host 127.0.0.1 --port 3401 --strictPort',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:3401',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
