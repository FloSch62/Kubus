import type { AppWindowLaunch } from '@kubus/shared';
export function routeFromDeepLink(raw: string): string | undefined {
  if (!raw.startsWith(`kubus://`)) return undefined;
  const rest = raw.slice(`kubus://`.length);
  const route = rest.startsWith('/') ? rest : `/${rest}`;
  // Reject protocol-relative smuggling — only same-app routes may pass.
  return route.startsWith('//') ? undefined : route;
}

export function parseWindowLaunch(value: unknown): AppWindowLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const launch = value as Record<string, unknown>;
  if (
    typeof launch.windowId !== 'string' ||
    !launch.windowId ||
    launch.windowId.length > 200 ||
    typeof launch.title !== 'string' ||
    launch.title.length > 500
  ) {
    return undefined;
  }
  if (launch.context !== undefined) {
    if (!launch.context || typeof launch.context !== 'object') return undefined;
    const context = launch.context as Record<string, unknown>;
    const validList = (items: unknown): items is string[] =>
      Array.isArray(items) &&
      items.length <= 1000 &&
      items.every((item) => typeof item === 'string' && item.length <= 1000);
    if (!validList(context.selected) || !validList(context.namespaces) || typeof context.navCollapsed !== 'boolean') return undefined;
  }
  if (launch.kind === 'tab-transfer') {
    return (launch.surface === 'page' || launch.surface === 'dock') &&
      typeof launch.transferId === 'string' && !!launch.transferId && launch.transferId.length <= 200
      ? (value as AppWindowLaunch)
      : undefined;
  }
  if ((launch.kind !== 'page' && launch.kind !== 'dock') || !launch.tab || typeof launch.tab !== 'object') return undefined;
  const tab = launch.tab as Record<string, unknown>;
  if (launch.kind === 'page') {
    return typeof tab.path === 'string' && tab.path.startsWith('/') && !tab.path.startsWith('//') && tab.path.length <= 8192
      ? (value as AppWindowLaunch)
      : undefined;
  }
  return typeof tab.kind === 'string' && ['terminal', 'node-shell', 'logs'].includes(tab.kind) && typeof tab.title === 'string'
    ? (value as AppWindowLaunch)
    : undefined;
}

export function isApplicationLaunch(launch?: AppWindowLaunch): boolean {
  return !launch || launch.kind === 'page' || (launch.kind === 'tab-transfer' && launch.surface === 'page');
}
