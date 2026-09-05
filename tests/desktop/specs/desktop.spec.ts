import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from '../helpers/app.js';

test('boots the built Bun server and renderer with a typed desktop bridge', async () => {
  const app = await launchDesktop();
  try {
    const info = await app.page.evaluate(async () => ({
      info: await window.kubusDesktop?.getAppInfo(),
      process: typeof (window as unknown as Record<string, unknown>).process,
      require: typeof (window as unknown as Record<string, unknown>).require,
    }));
    expect(info.info).toMatchObject({ name: 'Kubus', version: '0.9.0', helmEngine: true });
    expect(info.process).toBe('undefined');
    expect(info.require).toBe('undefined');
    await expect.poll(() => app.page.visible('button[aria-label="Settings"]')).toBe(true);
    await app.page.click('button[aria-label="Settings"]');
    await expect.poll(() => app.page.visible('[role="dialog"]')).toBe(true);
    expect(readFileSync(path.join(app.userDataDir, 'logs/main.log'), 'utf8')).toContain('Electrobun, Bun');
  } finally { await app.close(); }
});

test('opens page and utility windows and shares state in both directions', async () => {
  const app = await launchDesktop();
  try {
    const next = app.waitForWindow('secondary');
    await app.page.evaluate(() => window.kubusDesktop?.openWindow({ kind: 'page', windowId: 'secondary', title: 'Pods', tab: { path: '/r/core/v1/pods', customTitle: 'Native pods' } }));
    const secondary = await next;
    await expect.poll(() => secondary.url()).toMatch(/\/r\/core\/v1\/pods$/);
    await expect.poll(() => secondary.evaluate(() => document.querySelector('[role="tab"]')?.textContent)).toContain('Native pods');
    await app.page.evaluate(() => window.kubusDesktop?.stateStorage.setItem('sync-test', 'primary'));
    await expect.poll(() => secondary.evaluate(() => window.kubusDesktop?.stateStorage.getItem('sync-test'))).toBe('primary');
    await secondary.evaluate(() => window.kubusDesktop?.stateStorage.setItem('sync-test', 'secondary'));
    await expect.poll(() => app.page.evaluate(() => window.kubusDesktop?.stateStorage.getItem('sync-test'))).toBe('secondary');
    await app.page.reload();
    await app.page.waitForFunction(() => !!window.kubusDesktop);
    expect(await app.page.evaluate(() => window.kubusDesktop?.stateStorage.getItem('sync-test'))).toBe('secondary');
    const utilityPromise = app.waitForWindow('logs');
    await app.page.evaluate(() => window.kubusDesktop?.openWindow({ kind: 'dock', windowId: 'logs', title: 'Logs', tab: { kind: 'logs', title: 'Utility logs', ctx: 'test', namespace: 'default', pods: ['demo'] } }));
    const utility = await utilityPromise;
    await expect.poll(() => utility.visible('.kubus-dock-window-titlebar')).toBe(true);
    expect(await utility.count('button[aria-label="Settings"]')).toBe(0);
    await utility.evaluate(() => { setTimeout(() => window.kubusDesktop?.closeWindow(), 50); });
    await expect.poll(() => utility.isClosed()).toBe(true);
    expect(await app.page.isClosed()).toBe(false);
  } finally { await app.close(); }
});

test('persists state across complete process restarts', async () => {
  const first = await launchDesktop();
  let second: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await first.page.evaluate(() => window.kubusDesktop?.stateStorage.setItem('restart', 'durable'));
    await first.stop();
    expect(JSON.parse(readFileSync(path.join(first.userDataDir, 'client-state.json'), 'utf8')).restart).toBe('durable');
    second = await launchDesktop({ stateDir: first.stateDir });
    expect(await second.page.evaluate(() => window.kubusDesktop?.stateStorage.getItem('restart'))).toBe('durable');
    await second.page.evaluate(() => window.kubusDesktop?.stateStorage.removeItem('restart'));
    await second.stop();
    expect(JSON.parse(readFileSync(path.join(first.userDataDir, 'client-state.json'), 'utf8')).restart).toBeUndefined();
  } finally { await second?.close(); await first.close(); }
});

test('routes cold and second-instance deep links without another server', async () => {
  const app = await launchDesktop({ deepLink: 'kubus://r/core/v1/pods' });
  try {
    await expect.poll(() => app.page.url()).toMatch(/\/r\/core\/v1\/pods$/);
    const second = app.openLink('kubus://r/apps/v1/deployments');
    const exit = new Promise<number | null>((resolve) => second.once('exit', resolve));
    await expect.poll(() => app.page.url()).toMatch(/\/r\/apps\/v1\/deployments$/);
    expect(await exit).toBe(0);
    expect(await app.handles()).toHaveLength(1);
  } finally { await app.close(); }
});

test('window controls maximize and restore, and closing the last window stops the server', async () => {
  const app = await launchDesktop();
  const origin = new URL(await app.page.url()).origin;
  try {
    if (process.platform !== 'darwin') {
      const initial = await app.page.evaluate(() => ({ width: outerWidth, height: outerHeight }));
      await app.page.click('button[aria-label="Maximize or restore window"]');
      await expect.poll(() => app.page.evaluate(() => ({ width: outerWidth, height: outerHeight }))).not.toEqual(initial);
      await app.page.click('button[aria-label="Maximize or restore window"]');
      await expect.poll(() => app.page.evaluate(() => ({ width: outerWidth, height: outerHeight }))).toEqual(initial);
    }
    await app.stop();
    await expect.poll(async () => { try { await fetch(origin); return true; } catch { return false; } }).toBe(false);
  } finally { await app.close(); }
});

test('tab shortcuts close and cycle tabs without closing the native window', async () => {
  const app = await launchDesktop();
  try {
    await app.page.press('Alt+t');
    await expect.poll(() => app.page.count('[role="tab"]')).toBe(2);
    await app.page.press('Control+Tab');
    await app.page.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
    await expect.poll(() => app.page.count('[role="tab"]')).toBe(1);
    await app.page.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
    await expect.poll(() => app.page.count('[role="tab"]')).toBe(1);
    expect(await app.page.isClosed()).toBe(false);
  } finally { await app.close(); }
});
