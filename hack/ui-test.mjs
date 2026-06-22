// Headless UI smoke test: load the app, connect a cluster, browse pods,
// open the detail drawer, check overview + helm pages. Captures console
// errors and screenshots along the way.
import { chromium } from 'playwright-core';

const [, , token, ctx = 'kind-c9s-demo'] = process.argv;
const base = 'http://127.0.0.1:3199';
const shots = '/tmp/kubus-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, colorScheme: 'dark' });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

async function shot(name) {
  await page.screenshot({ path: `${shots}/${name}.png` });
  console.log(`📸 ${name}`);
}

try {
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'networkidle' });
  await shot('01-landing');

  // Open cluster switcher and connect the kind cluster.
  await page.getByRole('button', { name: /select clusters|clusters?/i }).first().click();
  await page.getByText(ctx).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
  await shot('02-overview');

  // Navigate to Pods.
  await page.getByRole('link', { name: 'Pods', exact: true }).click();
  await page.waitForTimeout(2000);
  const podRows = await page.locator('.MuiDataGrid-row').count();
  console.log(`✓ pods grid rows: ${podRows}`);
  if (podRows === 0) throw new Error('no pod rows rendered');
  await shot('03-pods');

  // Open detail drawer on the first row.
  await page.locator('.MuiDataGrid-row').first().click();
  await page.waitForTimeout(1500);
  await shot('04-detail');
  const yamlTab = page.getByRole('tab', { name: 'YAML' });
  await yamlTab.click();
  await page.waitForTimeout(2500); // monaco load
  await shot('05-yaml');
  const monacoVisible = await page.locator('.monaco-editor').count();
  console.log(`✓ monaco editors mounted: ${monacoVisible}`);
  await page.keyboard.press('Escape');

  // Helm page.
  await page.getByRole('link', { name: 'Helm Releases' }).click();
  await page.waitForTimeout(1500);
  const helmRows = await page.locator('.MuiDataGrid-row').count();
  console.log(`✓ helm rows: ${helmRows}`);
  await shot('06-helm');

  // Custom resources in nav (CRDs discovered).
  await page.getByText('Custom Resources').click();
  await page.waitForTimeout(500);
  await shot('07-crds');

  const fatal = errors.filter((e) => !e.includes('favicon') && !e.includes('Download the React DevTools'));
  if (fatal.length) {
    console.log('CONSOLE ERRORS:');
    for (const e of fatal) console.log(' -', e.slice(0, 300));
    process.exitCode = 1;
  } else {
    console.log('UI TEST PASSED — no console errors');
  }
} finally {
  await browser.close();
}
