import { expect, test, type Locator } from '@playwright/test';
import { launchElectron } from '../helpers/app.js';

const contextName = 'electron-titlebar-test';
const namespaceName = 'pointer-click-verified';

interface HitRegionDiagnostics {
  appRegion: string;
  className: string;
  platform: string;
  tagName: string;
}

async function hitRegionDiagnostics(root: Locator): Promise<HitRegionDiagnostics> {
  return root.evaluate((element) => {
    const style = getComputedStyle(element) as CSSStyleDeclaration & { webkitAppRegion?: string };
    return {
      appRegion: (style.webkitAppRegion ?? style.getPropertyValue('-webkit-app-region')) || '(unset)',
      className: element.className,
      platform: window.kubusDesktop?.platform ?? navigator.platform,
      tagName: element.tagName,
    };
  });
}

function hitRegionFailure(diagnostics: HitRegionDiagnostics): Error {
  return new Error(
    [
      `Namespace dropdown is part of Electron's draggable title-bar region on ${diagnostics.platform}.`,
      `Expected the rendered .MuiAutocomplete-root to compute -webkit-app-region: no-drag, but received "${diagnostics.appRegion}".`,
      'A draggable Autocomplete root causes the operating system to consume physical pointer clicks as window-drag gestures before MUI receives them.',
      'Apply WebkitAppRegion: "no-drag" to the complete NamespaceFilter Autocomplete root; applying it only to the nested input or popup button is insufficient.',
      `Rendered target: <${diagnostics.tagName.toLowerCase()} class="${diagnostics.className}">`,
    ].join('\n'),
  );
}

async function clickCenter(locator: Locator, description: string): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(
      `Cannot send a physical pointer click to ${description}: Playwright could not obtain its on-screen bounds. ` +
        'The control may be hidden, detached, or covered by the native title bar.',
    );
  }
  await locator.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('namespace dropdown receives pointer clicks inside the native title bar', async () => {
  const launched = await launchElectron();
  const { page } = launched;

  try {
    // Keep this test hermetic: the actual Electron server and renderer run, but
    // deterministic API responses avoid requiring a developer kubeconfig or a
    // reachable Kubernetes cluster on any CI operating system.
    await page.route(/\/api\/contexts$/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          {
            name: contextName,
            cluster: 'titlebar-test-cluster',
            user: 'titlebar-test-user',
            current: true,
            health: 'connected',
            active: true,
          },
        ]),
      });
    });
    await page.route(`**/api/contexts/${contextName}/namespaces`, async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([namespaceName, 'default']) });
    });
    await page.reload();

    const input = page.getByPlaceholder('All namespaces');
    await expect(input, 'The current context should render the namespace filter before hit-region testing').toBeVisible();
    const root = input.locator('xpath=ancestor::*[contains(@class, "MuiAutocomplete-root")]').first();
    await expect(root, 'The namespace input must remain inside the MUI Autocomplete root that owns the native hit region').toBeVisible();

    const diagnostics = await hitRegionDiagnostics(root);
    if (diagnostics.appRegion !== 'no-drag') throw hitRegionFailure(diagnostics);

    const openButton = root.getByRole('button', { name: 'Open' });
    await expect(openButton, 'The namespace popup indicator should be available for a pointer click').toBeVisible();
    await clickCenter(openButton, 'the namespace dropdown popup indicator');

    const listbox = page.getByRole('listbox');
    try {
      await expect(listbox).toBeVisible({ timeout: 5_000 });
    } catch (cause) {
      const latest = await hitRegionDiagnostics(root);
      throw new Error(
        [
          `A pointer click did not open the namespace dropdown on ${latest.platform}.`,
          `The Autocomplete root currently computes -webkit-app-region: "${latest.appRegion}".`,
          'This usually means the operating system intercepted the click as a title-bar drag, or another native overlay covers the popup indicator.',
          'Inspect TopBar and NamespaceFilter draggable-region styles before debugging namespace API data or MUI selection state.',
        ].join('\n'),
        { cause },
      );
    }

    const option = listbox.getByRole('option', { name: namespaceName });
    await expect(option, 'The deterministic namespace response should appear in the opened dropdown').toBeVisible();
    await clickCenter(option, `the "${namespaceName}" namespace option`);
    await expect(
      page.locator('.MuiAutocomplete-root').filter({ hasText: namespaceName }),
      'The pointer-selected namespace should be rendered as a chip in the Autocomplete root',
    ).toBeVisible();
  } finally {
    await launched.close();
  }
});
