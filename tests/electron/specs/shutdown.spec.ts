import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from '../helpers/app.js';

for (const scenario of ['close-window', 'stalled-close-window', 'stalled-quit'] as const) {
  test(`exits the desktop process on ${scenario}`, async () => {
    const launched = await launchElectron();
    const child = launched.app.process();
    const stalled = scenario.startsWith('stalled');
    try {
      await expect(launched.page).toHaveURL((url) => !url.searchParams.has('token'));
      await launched.page.evaluate(() => window.kubusDesktop?.stateStorage.setItem('shutdown-test', 'saved'));

      if (stalled) {
        const port = Number(new URL(launched.page.url()).port);
        // Simulate a server close that never completes, without exposing a
        // fault-injection API in the production app or touching real clusters.
        await launched.app.evaluate((_electron, serverPort) => {
          const { Server } = process.getBuiltinModule('node:http');
          // Preserve the receiver explicitly with call/apply below.
          // oxlint-disable-next-line typescript/unbound-method
          const originalClose = Server.prototype.close;
          Server.prototype.close = function (...args) {
            const address = this.address();
            if (address && typeof address === 'object' && address.port === serverPort) {
              return originalClose.call(this); // Deliberately omit the completion callback.
            }
            return originalClose.apply(this, args);
          };
        }, port);
      }

      await launched.app.evaluate(({ app, BrowserWindow }, quit) => {
        // Let evaluate return before the application tears down Playwright's connection.
        setTimeout(() => {
          if (quit) app.quit();
          else BrowserWindow.getAllWindows()[0]?.close();
        }, 50);
      }, scenario === 'stalled-quit');

      await expect.poll(() => child.exitCode, { timeout: 8_000 }).toBe(0);
      const log = readFileSync(path.join(launched.userDataDir, 'logs', 'main.log'), 'utf8');
      expect(log).toContain(stalled ? 'server shutdown timed out after 5000ms' : 'embedded server closed');
      const state = JSON.parse(readFileSync(path.join(launched.userDataDir, 'client-state.json'), 'utf8'));
      expect(state['shutdown-test']).toBe('saved');
      const bounds = JSON.parse(readFileSync(path.join(launched.userDataDir, 'window-state.json'), 'utf8'));
      expect(bounds.width).toBeGreaterThan(0);
    } finally {
      // A regression must fail the test without leaving the test app hung.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        });
      }
      await launched.close();
    }
  });
}
