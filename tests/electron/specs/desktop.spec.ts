import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from '../helpers/app.js';

test('boots the real desktop shell behind the restricted preload bridge', async () => {
  const launched = await launchElectron();
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    await expect(launched.page).toHaveTitle('Kubus');
    const surface = await launched.page.evaluate(async () => {
      const desktop = window.kubusDesktop;
      if (!desktop) throw new Error('desktop bridge was not installed');
      const unsafeWindow = window as unknown as Record<string, unknown>;
      return {
        keys: Object.keys(desktop).sort(),
        info: await desktop.getAppInfo(),
        nodeProcess: typeof unsafeWindow.process,
        nodeRequire: typeof unsafeWindow.require,
        url: window.location.href,
      };
    });

    expect(surface.keys).toEqual(
      [
        'checkForUpdate',
        'closeWindow',
        'getAppInfo',
        'getPendingRoute',
        'onCloseTab',
        'onCycleTab',
        'onOpenRoute',
        'platform',
        'setTitleBarOverlay',
        'stateStorage',
      ].sort(),
    );
    expect(surface.info).toMatchObject({ name: 'Kubus', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(typeof surface.info?.helmEngine).toBe('boolean');
    expect(surface.nodeProcess).toBe('undefined');
    expect(surface.nodeRequire).toBe('undefined');
    expect(new URL(surface.url).hostname).toBe('127.0.0.1');
    expect(new URL(surface.url).searchParams.has('token')).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.close();
  }
});

test('persists renderer state across the preload-to-main IPC boundary', async () => {
  const launched = await launchElectron();
  const stateFile = path.join(launched.userDataDir, 'client-state.json');
  let relaunched: Awaited<ReturnType<typeof launchElectron>> | undefined;

  try {
    await launched.page.evaluate(() => {
      window.kubusDesktop?.stateStorage.setItem('electron-e2e', 'persisted-value');
    });
    await expect.poll(() => {
      if (!existsSync(stateFile)) return undefined;
      return (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string>)['electron-e2e'];
    }).toBe('persisted-value');
    if (process.platform !== 'win32') expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    await launched.app.close();
    relaunched = await launchElectron({ stateDir: launched.stateDir });
    await expect(relaunched.page).toHaveTitle('Kubus');
    await expect(
      relaunched.page.evaluate(() => window.kubusDesktop?.stateStorage.getItem('electron-e2e')),
    ).resolves.toBe('persisted-value');

    await relaunched.page.evaluate(() => {
      window.kubusDesktop?.stateStorage.removeItem('electron-e2e');
    });
    await expect.poll(() => {
      if (!existsSync(stateFile)) return 'missing-file';
      return Object.hasOwn(JSON.parse(readFileSync(stateFile, 'utf8')) as object, 'electron-e2e');
    }).toBe(false);
  } finally {
    await (relaunched ?? launched).close();
  }
});

test('delivers native window accelerators through main and preload without closing the app', async () => {
  const launched = await launchElectron();

  try {
    await launched.page.evaluate(() => {
      const root = document.documentElement;
      window.kubusDesktop?.onCloseTab(() => root.setAttribute('data-native-close', 'received'));
      window.kubusDesktop?.onCycleTab((backwards) =>
        root.setAttribute('data-native-cycle', backwards ? 'backwards' : 'forwards'),
      );
    });

    await launched.app.evaluate(
      ({ BrowserWindow }, input) => {
        const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
        webContents?.sendInputEvent({ type: 'keyDown', ...input });
        webContents?.sendInputEvent({ type: 'keyUp', ...input });
      },
      { keyCode: 'w', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] },
    );
    await expect(launched.page.locator('html')).toHaveAttribute('data-native-close', 'received');
    expect(launched.page.isClosed()).toBe(false);

    await launched.app.evaluate(
      ({ BrowserWindow }, input) => {
        const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
        webContents?.sendInputEvent({ type: 'keyDown', ...input });
        webContents?.sendInputEvent({ type: 'keyUp', ...input });
      },
      { keyCode: 'Tab', modifiers: ['control'] },
    );
    await expect(launched.page.locator('html')).toHaveAttribute('data-native-cycle', 'forwards');
    await launched.app.evaluate(
      ({ BrowserWindow }, input) => {
        const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
        webContents?.sendInputEvent({ type: 'keyDown', ...input });
        webContents?.sendInputEvent({ type: 'keyUp', ...input });
      },
      { keyCode: 'Tab', modifiers: ['control', 'shift'] },
    );
    await expect(launched.page.locator('html')).toHaveAttribute('data-native-cycle', 'backwards');
  } finally {
    await launched.close();
  }
});

test('routes a cold-start kubus deep link into the renderer', async () => {
  const launched = await launchElectron({ deepLink: 'kubus://r/core/v1/pods?source=desktop-e2e' });

  try {
    await expect(launched.page).toHaveURL(/\/r\/core\/v1\/pods\?source=desktop-e2e$/);
    expect(await launched.page.evaluate(() => window.kubusDesktop?.getPendingRoute())).toBeNull();
  } finally {
    await launched.close();
  }
});
