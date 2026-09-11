import { expect, test } from '@playwright/test';
import { launchElectron } from '../helpers/app.js';

for (const shortcut of ['Ctrl+Tab', 'Ctrl+PgUp/PgDn', 'Alt+PgUp/PgDn']) {
  test(`${shortcut} keeps keyboard focus and shell input in the dock while cycling tabs`, async () => {
    const launched = await launchElectron();
    const { page } = launched;
    const shellInput = new Map<string, string>();
    let shellConnections = 0;
    const cycleTab = async (backwards = false) => {
      await launched.app.evaluate(({ BrowserWindow }, { shortcut, backwards }) => {
        const webContents = BrowserWindow.getAllWindows()[0]!.webContents;
        const modifiers: Array<'control' | 'alt' | 'shift'> = [shortcut.startsWith('Alt') ? 'alt' : 'control'];
        const usesPageKeys = shortcut !== 'Ctrl+Tab';
        if (!usesPageKeys && backwards) modifiers.push('shift');
        const keyCode = usesPageKeys ? (backwards ? 'PageUp' : 'PageDown') : 'Tab';
        webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      }, { shortcut, backwards });
    };

    try {
      // Keep the real renderer, xterm inputs, and native accelerators; only the
      // remote sessions are stubbed so this runs without a Kubernetes cluster.
      await page.routeWebSocket(/\/ws\/(exec|node-shell|logs)\?/, (socket) => {
        const url = new URL(socket.url());
        if (url.pathname === '/ws/logs') return;
        const session = url.searchParams.get('pod') ?? url.searchParams.get('node')!;
        shellConnections += 1;
        socket.onMessage((message) => {
          if (typeof message !== 'string') {
            shellInput.set(session, (shellInput.get(session) ?? '') + message.toString());
          }
        });
      });
      await page.evaluate(() => {
        sessionStorage.setItem('kubus-dock:main', JSON.stringify({
          tabs: [
            { kind: 'terminal', id: 'pod-shell', title: 'Pod shell', ctx: 'test', namespace: 'default', pod: 'web', container: 'web' },
            { kind: 'node-shell', id: 'node-shell', title: 'Node shell', ctx: 'test', node: 'worker' },
            { kind: 'logs', id: 'logs', title: 'Pod logs', ctx: 'test', namespace: 'default', pods: ['web'] },
          ],
          activeId: 'pod-shell',
          open: true,
          height: 320,
          maximized: false,
        }));
      });
      await page.reload();

      await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
      const help = page.getByRole('dialog');
      await help.getByPlaceholder('Search shortcuts…').fill(shortcut.split('/')[0]!.replace('+', ' '));
      await expect(help.getByText(shortcut === 'Ctrl+Tab' ? 'Next / previous tab' : 'Previous / next tab', { exact: true })).toBeVisible();
      await help.getByRole('button', { name: 'Close', exact: true }).click();

      // A second page tab makes accidental routing out of the dock observable.
      await page.getByRole('button', { name: 'New tab' }).click();
      const pageTabs = page.getByRole('tablist', { name: 'Open pages' }).getByRole('tab');
      await expect(pageTabs).toHaveCount(2);
      await expect(pageTabs.nth(1)).toHaveAttribute('aria-selected', 'true');

      const dock = page.locator('.kubus-bottom-dock');
      const input = dock.locator('.xterm:visible .xterm-helper-textarea');
      const podTab = dock.getByRole('tab', { name: /Pod shell/ });
      const nodeTab = dock.getByRole('tab', { name: /Node shell/ });
      const logsTab = dock.getByRole('tab', { name: /Pod logs/ });
      await expect(dock.locator('.xterm:visible')).toHaveCount(1);
      await expect.poll(() => shellConnections).toBe(2);
      await input.focus();
      await expect(input).toBeFocused();

      await cycleTab();
      await expect(nodeTab).toHaveAttribute('aria-selected', 'true');
      await expect(input).toBeFocused();
      await page.keyboard.type('node input');
      await expect.poll(() => shellInput.get('worker')).toBe('node input');

      await cycleTab(true);
      await expect(podTab).toHaveAttribute('aria-selected', 'true');
      await expect(input).toBeFocused();
      await page.keyboard.type('pod input');
      await expect.poll(() => shellInput.get('web')).toBe('pod input');

      // Crossing a log pane must retain dock ownership for the next shortcut.
      await cycleTab(true);
      await expect(logsTab).toHaveAttribute('aria-selected', 'true');
      await expect(dock).toBeFocused();
      await cycleTab();
      await expect(podTab).toHaveAttribute('aria-selected', 'true');
      await expect(input).toBeFocused();

      for (const tab of [nodeTab, logsTab, podTab]) {
        await cycleTab();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        if (tab === logsTab) await expect(dock).toBeFocused();
        else await expect(input).toBeFocused();
      }
      await page.keyboard.type(' after cycling');
      await expect.poll(() => shellInput.get('web')).toBe('pod input after cycling');
      await expect(pageTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      expect(shellConnections).toBe(2);

      // Once focus leaves the dock, the same chord still cycles page tabs.
      const search = page.getByRole('button', { name: 'Search', exact: true });
      await search.focus();
      await cycleTab();
      await expect(pageTabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(search).toBeFocused();
      await expect(podTab).toHaveAttribute('aria-selected', 'true');
    } finally {
      await launched.close();
    }
  });
}
