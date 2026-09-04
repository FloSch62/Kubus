import type { NavigateFunction, NavigateOptions, To } from 'react-router';

/**
 * The app's router navigation, reachable from code that renders outside a
 * router (dock windows, store actions, plain helpers). GlobalShortcuts
 * registers it once the router is mounted; before that, or in a window
 * without a router, navigation requests are dropped.
 */
let navigateFn: NavigateFunction | undefined;

export function registerAppNavigate(fn: NavigateFunction | undefined): void {
  navigateFn = fn;
}

export function appNavigate(to: To, options?: NavigateOptions): void {
  void navigateFn?.(to, options);
}
