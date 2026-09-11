import type { AppInfo, UpdateCheckResult } from '@kubus/shared';
import { apiFetch } from './http.js';

export async function getAppInfo(): Promise<AppInfo | null> {
  const desktop = window.kubusDesktop;
  if (desktop) return (await desktop.getAppInfo()) ?? null;
  return apiFetch<AppInfo>('/api/app/info');
}

export async function checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult> {
  return apiFetch<UpdateCheckResult>(`/api/app/update-check${options?.force ? '?force=true' : ''}`);
}
