// Screenshot capture for the Kubus docs.
// Usage: KUBUS_URL="http://127.0.0.1:3001/?token=..." [THEME=dark] node hack/capture.mjs [only]
//   THEME=dark captures the dark variants, written as <name>-dark.png.
import { chromium } from 'playwright-core';

const URL = process.env.KUBUS_URL;
const ONLY = process.argv[2]; // optional: capture only shots whose name includes this
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
const SUFFIX = THEME === 'dark' ? '-dark' : '';
const OUT = 'docs/assets/screenshots';
const VIEW = { width: 1480, height: 920 };
const SCALE = 2;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

async function newPage(selected, namespaces = [], contextSettings = {}) {
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: THEME });
  const page = await ctx.newPage();
  const val = JSON.stringify({ state: { selected, namespaces, themeMode: THEME, contextSettings }, version: 0 });
  await page.addInitScript((v) => localStorage.setItem('kubus-clusters', v), val);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return page;
}

const nav = (page, label) => page.getByText(label, { exact: true }).first().click();
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}${SUFFIX}.png` });

const shots = [];
const add = (name, fn) => shots.push({ name, fn });

add('overview', async () => {
  const page = await newPage(['kind-kubus-a'], []);
  await page.waitForTimeout(1500);
  await shot(page, 'overview');
  await page.context().close();
});

add('cluster-switcher', async () => {
  const page = await newPage(['kind-kubus-a'], []);
  await page.getByText(/kind-kubus-a/).first().click();
  await page.waitForTimeout(1000);
  await shot(page, 'cluster-switcher');
  await page.context().close();
});

add('pods', async () => {
  const page = await newPage(['kind-kubus-a', 'kind-kubus-b'], []);
  await nav(page, 'Pods');
  await page.waitForTimeout(2500);
  await shot(page, 'pods');
  await page.context().close();
});

add('crd-list', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Widgets', { delay: 50 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter'); // navigate to the Widgets list
  await page.waitForTimeout(2200);
  await page.keyboard.press('Escape'); // close the auto-opened detail drawer to show a clean list
  await page.waitForTimeout(900);
  await shot(page, 'crd-list');
  await page.context().close();
});

add('pod-detail', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await nav(page, 'Pods');
  await page.waitForTimeout(2000);
  await page.getByText(/^podinfo-/).first().click();
  await page.waitForTimeout(1800);
  await shot(page, 'pod-detail');
  await page.context().close();
});

add('metrics', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await nav(page, 'Pods');
  await page.waitForTimeout(2000);
  await page.getByText(/^podinfo-/).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('tab', { name: 'Metrics' }).click();
  await page.waitForTimeout(22000); // let samples accumulate
  await shot(page, 'metrics');
  await page.context().close();
});

add('rollout-history', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await nav(page, 'Deployments');
  await page.waitForTimeout(1800);
  await page.getByText('podinfo', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('tab', { name: 'History' }).click();
  await page.waitForTimeout(1500);
  await shot(page, 'rollout-history');
  await page.context().close();
});

add('events', async () => {
  const page = await newPage(['kind-kubus-a'], []);
  await nav(page, 'Events');
  await page.waitForTimeout(2500);
  await shot(page, 'events');
  await page.context().close();
});

add('helm-list', async () => {
  const page = await newPage(['kind-kubus-a'], []);
  await nav(page, 'Helm Releases');
  await page.waitForTimeout(2200);
  await shot(page, 'helm-list');
  await page.context().close();
});

add('helm-detail', async () => {
  const page = await newPage(['kind-kubus-a'], []);
  await nav(page, 'Helm Releases');
  await page.waitForTimeout(2200);
  await page.getByText('podinfo', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await shot(page, 'helm-detail');
  await page.context().close();
});

add('topology', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await nav(page, 'Topology');
  await page.waitForTimeout(3500);
  await shot(page, 'topology');
  await page.context().close();
});

add('command-palette', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('podinfo', { delay: 45 });
  await page.waitForTimeout(1200);
  await shot(page, 'command-palette');
  await page.context().close();
});

add('logs', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('podinfo', { delay: 45 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Tab'); // actions for the top (Deployment) result -> aggregated logs
  await page.waitForTimeout(700);
  await page.keyboard.type('logs', { delay: 45 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  await shot(page, 'logs');
  await page.context().close();
});

add('shell', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('podinfo', { delay: 45 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('ArrowDown'); // move to a pod
  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  await page.keyboard.type('shell', { delay: 45 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  // focus the terminal pane (bottom dock) before typing
  await page.mouse.click(VIEW.width / 2, VIEW.height - 120);
  await page.waitForTimeout(400);
  await page.keyboard.type('whoami && uname -sr && ls /', { delay: 25 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await page.keyboard.type('cat /etc/os-release', { delay: 25 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await shot(page, 'shell');
  await page.context().close();
});

add('settings', async () => {
  const page = await newPage(['kind-kubus-a'], []);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(1000);
  await page.getByText('Appearance', { exact: true }).first().click();
  await page.waitForTimeout(800);
  await shot(page, 'settings');
  await page.context().close();
});

add('diff', async () => {
  const page = await newPage(['kind-kubus-a', 'kind-kubus-b'], []);
  await nav(page, 'Diff');
  await page.waitForTimeout(2000);
  const combos = page.locator('[role="combobox"]');
  const pick = async (idx, rx) => {
    console.log(`  pick[${idx}] ${rx} (combos=${await combos.count()})`);
    await combos.nth(idx).click();
    await page.waitForTimeout(700);
    await page.getByRole('option', { name: rx }).first().click({ timeout: 8000 });
    await page.waitForTimeout(900);
  };
  // combobox 0 is the top-bar namespace filter. Selecting a namespaced kind
  // inserts a Namespace picker, so indices shift as we go.
  // left: cluster a / ConfigMap / kube-system / kube-root-ca.crt
  await pick(1, /kind-kubus-a/);   // L cluster
  await pick(2, /^ConfigMap$/);    // L kind -> inserts L namespace at idx 3
  await pick(3, /^kube-system$/);  // L namespace
  await pick(4, /kube-root-ca\.crt/); // L name
  // right: cluster b / ConfigMap / kube-system / kube-root-ca.crt
  await pick(5, /kind-kubus-b/);   // R cluster
  await pick(6, /^ConfigMap$/);    // R kind -> inserts R namespace at idx 7
  await pick(7, /^kube-system$/);  // R namespace
  await pick(8, /kube-root-ca\.crt/); // R name
  await page.waitForTimeout(1500);
  await shot(page, 'diff');
  await page.context().close();
});

add('port-forwards', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  // start a forward from the podinfo Service row menu, then show the page
  await nav(page, 'Services');
  await page.waitForTimeout(2000);
  const row = page.locator('[role="row"]', { hasText: 'podinfo' }).first();
  await row.hover();
  await row.getByRole('button').last().click(); // row ⋮ menu
  await page.waitForTimeout(600);
  await page.getByRole('menuitem', { name: /port forward/i }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /^start$/i }).click();
  await page.waitForTimeout(2500);
  await nav(page, 'Port Forwards');
  await page.waitForTimeout(1800);
  await shot(page, 'port-forwards');
  await page.context().close();
});

add('production-guard', async () => {
  const page = await newPage(['kind-kubus-a'], ['demo']);
  // protect the cluster via Settings → Clusters
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(800);
  await page.getByText('Clusters', { exact: true }).first().click();
  await page.waitForTimeout(800);
  const aRow = page.locator('[role="dialog"] li, [role="dialog"] tr, [role="dialog"] div', { hasText: 'kind-kubus-a' })
    .filter({ has: page.locator('[role="switch"], input[type="checkbox"]') }).first();
  await aRow.locator('[role="switch"], input[type="checkbox"]').first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  // open a Delete dialog on a throwaway widget (do NOT confirm)
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  await page.keyboard.type('Widgets', { delay: 50 });
  await page.waitForTimeout(900);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape'); // close the auto-opened detail drawer so row actions are reachable
  await page.waitForTimeout(900);
  const row = page.locator('[role="row"]', { hasText: 'bravo' }).first();
  await row.hover();
  await row.getByRole('button').last().click();
  await page.waitForTimeout(600);
  await page.getByRole('menuitem', { name: /delete/i }).click();
  await page.waitForTimeout(900);
  await shot(page, 'production-guard');
  await page.context().close();
});

let ok = 0, fail = 0;
for (const s of shots) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  try {
    await s.fn();
    console.log(`OK   ${s.name}`);
    ok++;
  } catch (e) {
    console.log(`FAIL ${s.name}: ${String(e).split('\n')[0]}`);
    fail++;
  }
}
console.log(`\nDone. ${ok} ok, ${fail} failed.`);
await browser.close();
