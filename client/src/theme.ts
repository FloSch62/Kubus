import { scrollbarSize } from '@kubus/ui-theme';
export { buildTheme, statusTextColor, titleBarColors } from '@kubus/ui-theme';

/**
 * Shared layout dimensions. Several of these are cross-file contracts:
 * anything that changes one side must keep the other in sync, so both sides
 * read the same token instead of repeating the number.
 */
export const layout = {
  /** TopBar toolbar height; drawers/panels below it offset by the same value. */
  topBarHeight: 52,
  navDrawerWidth: 228,
  /** Fixed tab width so the shrink-to-fit tablist sizes to n×tabs. */
  tabWidth: 190,
  /** Themed scrollbar thickness; grids reserve the same explicit gutter. */
  scrollbarSize,
  /**
   * The embedded detail panel's resize handle and collapse button overhang
   * the grid, whose floating scrollbars are MUI-internal zIndex 60 (70 on
   * hover) in the same stacking context — these must stay above both, and
   * the button above the handle.
   */
  zDetailResizeHandle: 71,
  zDetailCollapseButton: 72,
} as const;
