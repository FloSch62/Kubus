import type { Page } from '@playwright/test';
import { contextName } from './cluster.mjs';

// KUBUS_DEV=1 fixes the server token to `dev`; the client captures ?token=
// into sessionStorage on load, so every fresh page needs it once.
export const TOKEN = 'dev';

export async function gotoApp(page: Page, path = '/'): Promise<void> {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}token=${TOKEN}`);
}

/** Deep link straight to a resource's detail drawer. */
export function detailLink(plural: string, namespace: string, name: string): string {
  const sel = encodeURIComponent(`${contextName}|${namespace}|${name}`);
  return `/r/core/v1/${plural}?sel=${sel}`;
}
