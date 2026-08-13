import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { KeyboardInputEvent } from 'electron';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchElectron } from '../helpers/app.js';

type AcceleratorInput = Omit<KeyboardInputEvent, 'type'>;

async function sendAccelerator(
  app: ElectronApplication,
  input: AcceleratorInput,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, accelerator) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
      webContents?.sendInputEvent({ type: 'keyDown', ...accelerator });
      webContents?.sendInputEvent({ type: 'keyUp', ...accelerator });
    },
    input,
  );
}

test('boots the real desktop shell behind the restricted preload bridge', async () => {
  const launched = await launchElectron();
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    await expect(launched.page).toHaveTitle('Kubus');
    // The title is static HTML; token removal proves the renderer bootstrap completed.
    await expect(launched.page).toHaveURL((url) => !url.searchParams.has('token'));
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
        'detachTab',
        'getAppInfo',
        'getPendingRoute',
        'onCloseTab',
        'onCycleTab',
        'onOpenRoute',
        'openWindow',
        'platform',
        'setTitleBarOverlay',
        'stateStorage',
        'windowLaunch',
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

test('opens a routed native window and synchronizes shared renderer state both ways', async () => {
  const launched = await launchElectron();

  try {
    const secondaryPromise = launched.app.waitForEvent('window');
    await launched.page.evaluate(() => {
      window.kubusDesktop?.openWindow({
        kind: 'page',
        windowId: 'electron-secondary',
        title: 'Pods',
        tab: { path: '/r/core/v1/pods', customTitle: 'Native pods', color: '#42a5f5' },
      });
    });
    const secondary = await secondaryPromise;
    await expect(secondary).toHaveURL(/\/r\/core\/v1\/pods$/);
    await expect(secondary.getByRole('tab', { name: /Native pods/ })).toBeVisible();
    expect(await secondary.evaluate(() => window.kubusDesktop?.windowLaunch?.windowId)).toBe('electron-secondary');
    expect(await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);

    await launched.page.evaluate(() => window.kubusDesktop?.stateStorage.setItem('electron-window-sync', 'from-primary'));
    await expect.poll(() => secondary.evaluate(() => window.kubusDesktop?.stateStorage.getItem('electron-window-sync')))
      .toBe('from-primary');
    await secondary.evaluate(() => window.kubusDesktop?.stateStorage.setItem('electron-window-sync', 'from-secondary'));
    await expect.poll(() => launched.page.evaluate(() => window.kubusDesktop?.stateStorage.getItem('electron-window-sync')))
      .toBe('from-secondary');

    // Theme is durable app-wide configuration and should update live.
    await launched.page.getByRole('button', { name: 'Toggle theme' }).click();
    await secondary.getByRole('button', { name: 'Toggle theme' }).hover();
    await expect(secondary.getByRole('tooltip')).toContainText('Switch to dark mode');

    await secondary.evaluate(() => window.kubusDesktop?.closeWindow());
    await expect.poll(() => secondary.isClosed()).toBe(true);
    expect(launched.page.isClosed()).toBe(false);
    expect(await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await launched.close();
  }
});

test('opens terminal and log content in focused native utility windows', async () => {
  const launched = await launchElectron();

  try {
    const secondaryPromise = launched.app.waitForEvent('window');
    await launched.page.evaluate(() => {
      window.kubusDesktop?.openWindow({
        kind: 'dock',
        windowId: 'electron-log-utility',
        title: 'Logs: logger',
        context: { selected: [], namespaces: ['default'], navCollapsed: false },
        tab: {
          kind: 'logs',
          title: 'Logs: logger',
          ctx: 'kind-a',
          namespace: 'default',
          pods: ['logger'],
        },
      });
    });
    const logUtility = await secondaryPromise;

    await expect(logUtility.locator('.kubus-dock-window-titlebar')).toBeVisible();
    await expect(logUtility.getByRole('tab', { name: /Logs: logger/ })).toBeVisible();
    await expect(logUtility.locator('.MuiDrawer-root')).toHaveCount(0);
    await expect(logUtility.getByRole('button', { name: 'New tab' })).toHaveCount(0);
    await expect(logUtility.locator('.kubus-bottom-dock')).toHaveCSS('height', /.+/);
    expect(await logUtility.evaluate(() => window.kubusDesktop?.windowLaunch?.windowId)).toBe('electron-log-utility');

    // The utility BrowserWindow owns its content: closing its last dock tab
    // closes that window, without affecting the main application window.
    await logUtility.getByRole('button', { name: 'Close Logs: logger' }).click();
    await expect.poll(() => logUtility.isClosed()).toBe(true);
    expect(launched.page.isClosed()).toBe(false);

    const terminalPromise = launched.app.waitForEvent('window');
    await launched.page.evaluate(() => {
      window.kubusDesktop?.openWindow({
        kind: 'dock',
        windowId: 'electron-terminal-utility',
        title: 'sh: logger',
        context: { selected: [], namespaces: ['default'], navCollapsed: false },
        tab: {
          kind: 'terminal',
          title: 'sh: logger',
          ctx: 'kind-a',
          namespace: 'default',
          pod: 'logger',
          container: 'logger',
        },
      });
    });
    const terminalUtility = await terminalPromise;

    await expect(terminalUtility.locator('.kubus-dock-window-titlebar')).toBeVisible();
    await expect(terminalUtility.locator('.xterm')).toBeVisible();
    await expect(terminalUtility.locator('.MuiDrawer-root')).toHaveCount(0);
    await expect(terminalUtility.getByRole('button', { name: 'New tab' })).toHaveCount(0);

    // Durable presentation preferences are critical shared state even though
    // each window's tabs, navigation and active working context stay local.
    const before = await terminalUtility.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // os -> light leaves pixels unchanged on this light runner; light -> dark
    // proves the shared preference reached the utility renderer.
    await launched.page.getByRole('button', { name: 'Toggle theme' }).click();
    await launched.page.getByRole('button', { name: 'Toggle theme' }).click();
    await expect.poll(() => terminalUtility.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(before);

    await terminalUtility.getByRole('button', { name: 'Close sh: logger' }).click();
    await expect.poll(() => terminalUtility.isClosed()).toBe(true);
    expect(launched.page.isClosed()).toBe(false);
  } finally {
    await launched.close();
  }
});

test('moves a page tab through the native window handoff path', async () => {
  const launched = await launchElectron({ deepLink: 'kubus://r/core/v1/pods' });

  try {
    const podsTab = launched.page.getByRole('tab', { name: /Pods/ }).first();
    await expect(podsTab).toBeVisible();
    await launched.page.getByRole('button', { name: 'New tab' }).click();
    await expect(launched.page.getByRole('tab', { name: /Overview/ })).toBeVisible();

    // Window layout is copied for continuity, then becomes independent.
    await launched.page.setViewportSize({ width: 1200, height: 800 });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const primaryDrawer = launched.page.locator('.MuiDrawer-root').first();
    await launched.page.keyboard.press(`${modifier}+b`);
    await expect(primaryDrawer).toHaveCSS('width', '0px');

    // Re-resolve by strip position after the nav-width transition; Chromium
    // can keep the pre-transition accessibility node stale for a frame.
    await launched.page.locator('[role="tab"]').first().click({ button: 'right' });
    const secondaryPromise = launched.app.waitForEvent('window');
    await launched.page.getByRole('menuitem', { name: 'Move to new window', exact: true }).click();
    const secondary = await secondaryPromise;

    await expect(secondary).toHaveURL(/\/r\/core\/v1\/pods$/);
    await expect(secondary.getByRole('tab', { name: /Pods/ })).toBeVisible();
    await expect(secondary.locator('.kubus-dock-window-titlebar')).toHaveCount(0);
    await expect(launched.page.getByRole('tab', { name: /Pods/ })).toHaveCount(0);
    await expect(launched.page.getByRole('tab', { name: /Overview/ })).toBeVisible();
    expect(await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);

    await secondary.setViewportSize({ width: 1200, height: 800 });
    const secondaryDrawer = secondary.locator('.MuiDrawer-root').first();
    await expect(secondaryDrawer).toHaveCSS('width', '0px');
    await secondary.keyboard.press(`${modifier}+b`);
    await expect(secondaryDrawer).toHaveCSS('width', '228px');
    await expect(primaryDrawer).toHaveCSS('width', '0px');

    await secondary.evaluate(() => window.kubusDesktop?.closeWindow());
    await expect.poll(() => secondary.isClosed()).toBe(true);
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

    await sendAccelerator(
      launched.app,
      { keyCode: 'w', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] },
    );
    await expect(launched.page.locator('html')).toHaveAttribute('data-native-close', 'received');
    expect(launched.page.isClosed()).toBe(false);

    await sendAccelerator(launched.app, { keyCode: 'Tab', modifiers: ['control'] });
    await expect(launched.page.locator('html')).toHaveAttribute('data-native-cycle', 'forwards');
    await sendAccelerator(launched.app, {
      keyCode: 'Tab',
      modifiers: ['control', 'shift'],
    });
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
