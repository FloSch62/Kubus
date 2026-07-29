import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { contextName } from '../helpers/cluster.mjs';

test('command palette opens with mod+k and closes with escape', async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole('button', { name: contextName })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByPlaceholder(/Search resources, pages, kinds/);
  await expect(palette).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('g-sequences jump between pages', async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole('button', { name: contextName })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/r\/core\/v1\/pods/);

  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveURL(/\/helm/);

  await page.keyboard.press('g');
  await page.keyboard.press('o');
  await expect(page).toHaveURL(/\/$/);
});

test('alt+j focuses and mod+j toggles an existing terminal without closing its session', async ({ page }) => {
  let execSocketCount = 0;
  let execSocketClosed = false;
  let terminalDataFrameCount = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/ws/exec?')) return;
    execSocketCount += 1;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') terminalDataFrameCount += 1;
    });
    socket.on('close', () => {
      execSocketClosed = true;
    });
  });

  await gotoApp(page, '/r/core/v1/pods');
  const row = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: 'kubus-e2e' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Shell' }).click();

  const terminal = page.locator('.xterm');
  const terminalInput = page.locator('.xterm-helper-textarea');
  await expect(terminal).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => execSocketCount).toBe(1);

  const searchButton = page.getByRole('button', { name: 'Search' });
  await searchButton.focus();
  await page.keyboard.press('Alt+j');
  await expect(terminalInput).toBeFocused();

  await page.keyboard.press('ControlOrMeta+j');
  await expect(searchButton).toBeFocused();
  await expect(terminal).toBeHidden();
  // The terminal stays mounted and its exec connection remains alive while
  // the dock is collapsed.
  await expect(terminal).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(execSocketClosed).toBe(false);

  await page.keyboard.press('ControlOrMeta+j');
  await expect(terminal).toBeVisible();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(searchButton).toBeFocused();
  await expect(terminal).toBeHidden();

  const dataFramesBeforeRepeat = terminalDataFrameCount;
  await page.keyboard.down('Control');
  await page.keyboard.down('j');
  await expect(terminal).toBeVisible();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.down('j');
  await page.keyboard.up('j');
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  expect(terminalDataFrameCount).toBe(dataFramesBeforeRepeat);

  await page.keyboard.press('ControlOrMeta+j');
  await expect(terminal).toBeHidden();
  await page.keyboard.press('Alt+j');
  await expect(terminal).toBeVisible();
  await expect(terminalInput).toBeFocused();
  expect(execSocketCount).toBe(1);
  expect(execSocketClosed).toBe(false);
});
