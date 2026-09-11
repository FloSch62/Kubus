import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';

test('virtualized resource cells retain selection and keyboard focus across fast scroll jumps', async ({ page }) => {
  // Feed an 80-row read-only snapshot through the real watch client without
  // creating resources in the cluster. All unrelated traffic remains live.
  const items = Array.from({ length: 80 }, (_, index) => ({
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { uid: `grid-${index}`, name: `grid-${String(index).padStart(4, '0')}`, namespace: 'kubus-e2e',
      resourceVersion: '1', creationTimestamp: '2026-01-01T00:00:00Z', labels: { app: 'grid-test' } },
    data: { value: String(index) },
  }));
  await page.routeWebSocket(/\/ws\/watch(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    const ids = new Set<string>();
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { op: string; id: string; plural?: string };
      if (message.op === 'sub' && message.plural === 'configmaps') ids.add(message.id);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { op: string; id: string };
      if (!ids.has(message.id)) { socket.send(raw); return; }
      if (message.op === 'snapshot') socket.send(JSON.stringify({ ...message, items }));
      else if (message.op !== 'event' && message.op !== 'events') socket.send(raw);
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page, '/r/core/v1/configmaps');
  const grid = page.locator('.kubus-table .MuiDataGrid-root');
  const scroller = grid.locator('.MuiDataGrid-virtualScroller');
  const row = (name: string) => grid.getByRole('row').filter({ hasText: name });
  await expect(row('grid-0000')).toBeVisible({ timeout: 20_000 });
  expect(await grid.locator('.MuiDataGrid-row').count()).toBeLessThan(50);
  await row('grid-0000').getByRole('checkbox').check();
  await expect(row('grid-0000').getByRole('checkbox')).toBeChecked();

  for (const bottom of [true, false, true, false]) {
    await scroller.evaluate((element, atBottom) => { element.scrollTop = atBottom ? element.scrollHeight : 0; }, bottom);
    await expect(row(bottom ? 'grid-0079' : 'grid-0000')).toBeVisible();
    expect(await grid.locator('.MuiDataGrid-row').count()).toBeLessThan(50);
  }
  await expect(row('grid-0000').getByRole('checkbox')).toBeChecked();
  // Focus the read-only age cell so navigation does not also open a detail panel.
  const cell = row('grid-0000').locator('[data-field="age"]');
  await cell.click();
  await page.keyboard.press('ArrowDown');
  await expect(row('grid-0001').locator('[data-field="age"]')).toBeFocused();
});
