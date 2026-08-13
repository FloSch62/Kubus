import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { namespace } from '../helpers/cluster.mjs';

test('page tabs expose the complete menu and open an isolated synchronized window', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/pods');
  const podsTab = page.getByRole('tab', { name: /Pods/ }).first();
  await expect(podsTab).toBeVisible({ timeout: 20_000 });

  await podsTab.click({ button: 'right' });
  for (const action of [
    'Rename tab',
    'Pin tab',
    'Duplicate tab',
    'Open in new window',
    'Move to new window',
    'Close tab',
    'Close other tabs',
    'Close tabs to the right',
  ]) {
    await expect(page.getByRole('menuitem', { name: action, exact: true })).toBeVisible();
  }

  await page.getByRole('menuitem', { name: 'Rename tab' }).click();
  await page.getByRole('textbox', { name: 'Tab name' }).fill('Production pods');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('tab', { name: /Production pods/ })).toBeVisible();

  await page.getByRole('tab', { name: /Production pods/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab' }).click();
  await expect(page.getByRole('tab', { name: /Production pods/ }).getByLabel('Pinned')).toBeVisible();

  await page.getByRole('tab', { name: /Production pods/ }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Flag tab #42a5f5' }).click();
  await expect.poll(() => page.getByRole('tab', { name: /Production pods/ }).evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain('rgb(66, 165, 245)');

  await page.getByRole('tab', { name: /Production pods/ }).click({ button: 'right' });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: 'Open in new window' }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/r\/core\/v1\/pods/);
  await expect(popup.getByRole('tab', { name: /Production pods/ })).toBeVisible();
  await expect(popup.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Production pods/ })).toBeVisible();
  await popup.close();
});

test('moves a live shell with its process state and scrollback intact', async ({ page }) => {
  await gotoApp(page, '/r/core/v1/pods');
  const row = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: namespace }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Shell' }).click();

  const sourceTerminal = page.locator('.xterm');
  const sourceInput = page.locator('.xterm-helper-textarea');
  await expect(sourceTerminal).toBeVisible({ timeout: 20_000 });
  await sourceInput.focus();
  await page.keyboard.type("export KUBUS_HANDOFF='still-here'");
  await page.keyboard.press('Enter');
  await page.keyboard.type("printf 'SOURCE-%s\\n' \"$KUBUS_HANDOFF\"");
  await page.keyboard.press('Enter');
  await expect(sourceTerminal).toContainText('SOURCE-still-here', { timeout: 10_000 });

  const sourceTab = page.getByRole('tab', { name: /sh: logger/ });
  await sourceTab.click({ button: 'right' });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: 'Move to new window' }).click();
  const popup = await popupPromise;

  const destinationTerminal = popup.locator('.xterm');
  const destinationInput = popup.locator('.xterm-helper-textarea');
  await expect(popup.locator('.kubus-dock-window-titlebar')).toBeVisible();
  await expect(popup.locator('.MuiDrawer-root')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'New tab' })).toHaveCount(0);
  await expect(destinationTerminal).toBeVisible({ timeout: 20_000 });
  await expect(destinationTerminal).toContainText('SOURCE-still-here', { timeout: 10_000 });
  await expect(sourceTab).toHaveCount(0, { timeout: 10_000 });

  await destinationInput.focus();
  await popup.keyboard.type("printf 'DEST-%s\\n' \"$KUBUS_HANDOFF\"");
  await popup.keyboard.press('Enter');
  await expect(destinationTerminal).toContainText('DEST-still-here', { timeout: 10_000 });
  await popup.close();
});

test('opens logs in a focused utility window without the Kubus application chrome', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoApp(page, '/r/core/v1/pods');
  const row = page.getByRole('row').filter({ hasText: 'logger' }).filter({ hasText: namespace }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^Logs/ }).click();
  await expect(page.getByText('kubus-e2e log line').first()).toBeVisible({ timeout: 30_000 });

  const sourceDock = page.locator('.kubus-bottom-dock');
  const sourceTab = sourceDock.getByRole('tab').filter({ hasText: /logs:/i }).first();
  await sourceTab.click({ button: 'right' });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: 'Open in new window' }).click();
  const popup = await popupPromise;

  await expect(popup.locator('.kubus-dock-window-titlebar')).toBeVisible();
  await expect(popup.locator('.MuiDrawer-root')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'New tab' })).toHaveCount(0);
  await expect(popup.getByText('kubus-e2e log line').first()).toBeVisible({ timeout: 30_000 });
  await expect(sourceTab).toBeVisible();
  await popup.close();
});
