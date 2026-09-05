import type { AppInfo } from '@kubus/shared';
import { apiFetch } from './http.js';

export async function getAppInfo(): Promise<AppInfo | null> {
  const desktop = window.kubusDesktop;
  if (desktop) return (await desktop.getAppInfo()) ?? null;
  return apiFetch<AppInfo>('/api/app/info');
}
