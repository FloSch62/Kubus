import { createContext, useContext } from 'react';

/**
 * Whether the enclosing tab pane is the active (visible) one. Pages stay
 * mounted and live in hidden panes, so any effect that mirrors page state
 * into a global singleton (URL, detail drawer) must gate on this.
 * Defaults to true for content rendered outside the tab panes.
 */
export const PaneActiveContext = createContext(true);

export function usePaneActive(): boolean {
  return useContext(PaneActiveContext);
}
