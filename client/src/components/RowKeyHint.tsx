import Box from '@mui/material/Box';
import { rowKeyDef, type RowKeyAction } from '../row-keys.js';
import { Kbd } from './Kbd.js';

/**
 * The key that runs an action on a focused list row, printed at the right
 * edge of a menu or palette item. Hidden from assistive tech: the item
 * carries the same key as `aria-keyshortcuts` instead of in its name.
 */
export function RowKeyHint({ action, title }: { action: RowKeyAction; title?: string }) {
  return (
    <Box component="span" aria-hidden title={title} sx={{ ml: 'auto', pl: 2.5, display: 'inline-flex', flexShrink: 0, opacity: 0.85 }}>
      <Kbd>{rowKeyDef(action).label}</Kbd>
    </Box>
  );
}

/** Props that announce a row key on a menu item, or nothing when hints are off. */
export function rowKeyItemProps(action: RowKeyAction, enabled: boolean | undefined): { 'aria-keyshortcuts'?: string } {
  return enabled ? { 'aria-keyshortcuts': rowKeyDef(action).aria } : {};
}
