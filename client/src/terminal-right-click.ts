import type { RightClickAction } from './state/prefs.js';

export function xtermRightClickSelectsWord(platformDefault: boolean, action: RightClickAction, hasSelection: boolean): boolean {
  return platformDefault && action === 'menu' && !hasSelection;
}

export type TerminalRightClickIntent =
  | { kind: 'copy'; selection: string }
  | { kind: 'paste' }
  | { kind: 'menu'; selection: string };

/** Resolve a right click from the selection that existed when it occurred. */
export function terminalRightClickIntent(action: RightClickAction, selection: string): TerminalRightClickIntent {
  if (action === 'menu') return { kind: 'menu', selection };
  if (action === 'copy-paste' && selection) return { kind: 'copy', selection };
  return { kind: 'paste' };
}
