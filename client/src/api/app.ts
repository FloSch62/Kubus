import type { AppInfo, UpdateCheckResult } from '@kubus/shared';
import { apiFetch } from './http.js';

export async function getAppInfo(): Promise<AppInfo | null> {
  const getInfo = window.kubusDesktop?.getAppInfo;
  if (getInfo) return (await getInfo()) ?? null;
  return apiFetch<AppInfo>('/api/app/info');
}

export async function checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult> {
  const check = window.kubusDesktop?.checkForUpdate;
  if (check) return check(options);
  return apiFetch<UpdateCheckResult>(`/api/app/update-check${options?.force ? '?force=true' : ''}`);
}
