import { expect, test } from '@playwright/test';
import { gotoApp } from '../helpers/app.js';
import { contextName, kubectl, namespace } from '../helpers/cluster.mjs';

const annotation = 'kubus-e2e/manifest';

function deploymentLink(name: string): string {
  return `/r/apps/v1/deployments?sel=${encodeURIComponent(`${contextName}|${namespace}|${name}`)}`;
}

function clearAnnotation(): void {
  kubectl(['annotate', 'deployment', 'web', '-n', namespace, `${annotation}-`, '--overwrite']);
}

test.beforeEach(clearAnnotation);
test.afterEach(clearAnnotation);

test('renders the manifest tree with aligned values, types and locked status', async ({ page }) => {
  await gotoApp(page, deploymentLink('web'));
  await expect(page.getByText(`${namespace} / web`)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Manifest' }).click();

  const replicas = page.getByRole('treeitem').filter({ hasText: /^replicas/ }).first();
  await expect(replicas).toBeVisible({ timeout: 20_000 });
  await expect(replicas).toContainText('2');
  await expect(replicas).toContainText('int');
  // Status rows carry the lock and cannot be edited.
  const ready = page.getByRole('treeitem').filter({ hasText: /^readyReplicas/ }).first();
  await expect(ready.getByLabel(/Status is written by the controller/)).toBeVisible();

  await page.getByRole('textbox', { name: 'Filter manifest' }).fill('nginx');
  await expect(page.getByRole('treeitem').filter({ hasText: /^image/ }).first()).toContainText('nginx:1.27-alpine');
  await expect(page.getByRole('treeitem').filter({ hasText: /^replicas/ })).toHaveCount(0);
});

test('adds an annotation in the tree and applies it through review and dry-run', async ({ page }) => {
  await gotoApp(page, deploymentLink('web'));
  await expect(page.getByText(`${namespace} / web`)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Manifest' }).click();
  await page.getByRole('button', { name: /^Metadata/ }).click();

  const annotations = page.getByRole('treeitem').filter({ hasText: /^annotations/ }).first();
  await expect(annotations).toBeVisible({ timeout: 20_000 });
  await annotations.hover();
  await annotations.getByRole('button', { name: 'Add field to annotations' }).click();
  const picker = page.getByRole('textbox', { name: 'Field name' });
  await picker.fill(annotation);
  await picker.press('Enter');

  const value = page.getByRole('textbox', { name: 'Value' });
  await expect(value).toBeVisible();
  await value.fill('from-the-tree');
  await value.press('Enter');
  await expect(page.getByText('1 change')).toBeVisible();

  // The draft carries into the YAML tab and back.
  await page.getByRole('tab', { name: 'YAML' }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.monaco-editor').first()).toContainText('from-the-tree');
  await page.getByRole('tab', { name: 'Manifest' }).click();
  await expect(page.getByText('1 change')).toBeVisible();

  await page.getByRole('button', { name: 'Review & apply' }).click();
  const review = page.getByRole('dialog').filter({ hasText: 'Review changes' });
  await expect(review).toBeVisible();
  await expect(review.getByText('Server dry-run accepted this change.')).toBeVisible({ timeout: 20_000 });
  const apply = review.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(page.getByText('Deployment web updated')).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => kubectl(['get', 'deployment/web', '-n', namespace, '-o', `jsonpath={.metadata.annotations.kubus-e2e/manifest}`]).trim(),
    { timeout: 20_000 },
  ).toBe('from-the-tree');
  await expect(page.getByRole('button', { name: 'Review & apply' })).toBeDisabled();
});
