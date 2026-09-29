import { IS_MAC } from './platform.js';

/** Actions a single key runs on the focused list row. */
export type RowKeyAction = 'logs' | 'shell' | 'forward' | 'scale' | 'restart' | 'manifest' | 'delete';

export interface RowKeyDef {
  action: RowKeyAction;
  /** `KeyboardEvent.key` values (letters lower-cased) that trigger the action. */
  keys: string[];
  /** Keycap text shown in menus, the palette and the help dialog. */
  label: string;
  /** `aria-keyshortcuts` value for menu items that run the action. */
  aria: string;
  /** Help dialog wording. */
  description: string;
}

/**
 * The one action-to-key mapping. Row menu hints, palette hints and the `?`
 * help entries are all derived from this list, so they cannot drift from
 * what the grid dispatches.
 */
export const ROW_KEYS: readonly RowKeyDef[] = [
  { action: 'logs', keys: ['l'], label: 'L', aria: 'L', description: 'Logs (pods, workloads, services, jobs)' },
  { action: 'shell', keys: ['x'], label: 'X', aria: 'X', description: 'Shell (pods) · node shell (nodes), after confirming' },
  { action: 'forward', keys: ['f'], label: 'F', aria: 'F', description: 'Port forward (pods, services, workloads)' },
  { action: 'scale', keys: ['s'], label: 'S', aria: 'S', description: 'Scale (Deployments, StatefulSets, ReplicaSets) · elsewhere S focuses the filter' },
  { action: 'restart', keys: ['r'], label: 'R', aria: 'R', description: 'Restart (workloads, ReplicaSet pods), after confirming' },
  { action: 'manifest', keys: ['e'], label: 'E', aria: 'E', description: 'Open the Manifest tab' },
  // Mac keyboards label Backspace "delete", so both keys delete.
  { action: 'delete', keys: ['delete', 'backspace'], label: IS_MAC ? '⌫' : 'Del', aria: 'Delete Backspace', description: 'Delete, after confirming' },
];

const BY_ACTION = new Map(ROW_KEYS.map((def) => [def.action, def]));

export function rowKeyDef(action: RowKeyAction): RowKeyDef {
  return BY_ACTION.get(action)!;
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** The row action a key press asks for; chords never match, so Ctrl/Cmd/Alt combinations keep their meaning. */
export function rowKeyForEvent(event: KeyLike): RowKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const key = event.key.toLowerCase();
  return ROW_KEYS.find((def) => def.keys.includes(key))?.action;
}

/** `j` moves the row cursor down, `k` up (vi-style, next to the arrow keys). */
export function rowCursorStep(event: KeyLike & { shiftKey: boolean }): 1 | -1 | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined;
  if (event.key === 'j') return 1;
  if (event.key === 'k') return -1;
  return undefined;
}
