import { useEffect, type RefObject } from 'react';
import { usePaneActive } from '../layout/pane-context.js';
import { isTextEntryTarget } from '../text-entry.js';

/**
 * Find (Ctrl/Cmd+F) and quick-search (`s` `/` `:`) shortcuts that focus a
 * page's search input. Gated on the pane being visible: pages stay mounted
 * in hidden panes, and only one listener may own the shortcut.
 *
 * Focus is moved synchronously in the keydown handler — deferring it would
 * open a gap where keystrokes typed right after the trigger key still hit
 * the grid underneath.
 */
export function useQuickSearchShortcut(inputRef: RefObject<HTMLInputElement | null>): void {
  const paneActive = usePaneActive();
  useEffect(() => {
    if (!paneActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextEntryTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const shortcutModifier = event.ctrlKey || event.metaKey;
      const isFindShortcut = shortcutModifier && !event.altKey && !event.shiftKey && key === 'f';
      const isQuickSearchShortcut = !shortcutModifier && !event.altKey && (key === 's' || key === ':' || key === '/');
      if (!isFindShortcut && !isQuickSearchShortcut) return;
      // `/` keeps its default action: after focus moves, the browser inserts
      // it into the (selected) input, dropping the user straight into
      // smart-filter syntax. The other triggers must not be typed.
      if (key !== '/') event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inputRef, paneActive]);
}
