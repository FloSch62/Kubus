import { alpha, createTheme, type Theme } from '@mui/material/styles';
import type {} from '@mui/x-data-grid/themeAugmentation';

declare module '@mui/material/styles' {
  /** Chrome surfaces (top bar, nav rail, tab strip) share this background —
   *  exposed on the palette so no component re-hardcodes the hex. */
  interface Palette {
    sidebar: string;
  }
  interface PaletteOptions {
    sidebar?: string;
  }
}

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
  scrollbarSize: 10,
  /**
   * The embedded detail panel's resize handle and collapse button overhang
   * the grid, whose floating scrollbars are MUI-internal zIndex 60 (70 on
   * hover) in the same stacking context — these must stay above both, and
   * the button above the handle.
   */
  zDetailResizeHandle: 71,
  zDetailCollapseButton: 72,
} as const;

/**
 * Status hue for small colored text (status words, ready counts). The bright
 * palette mains pass contrast on dark paper but fail WCAG AA as 12-13px text
 * on the light backgrounds, so light mode drops to the pinned `dark` variant.
 */
export const statusTextColor =
  (color: 'success' | 'error' | 'warning' | 'info') =>
  (theme: Theme): string =>
    theme.palette.mode === 'dark' ? theme.palette[color].main : theme.palette[color].dark;

const darkColors = {
        primary: '#6e8bfb',
        secondary: '#2dd4bf',
        bgDefault: '#1b1b1f',
        bgPaper: '#232328',
        sidebar: '#151518',
        divider: 'rgba(255, 255, 255, 0.08)',
        textPrimary: '#e6e6ea',
        textSecondary: '#9d9da7',
        success: '#4ade80',
        warning: '#e7b341',
        error: '#f87171',
        info: '#60a5fa',
        scrollThumb: 'rgba(255, 255, 255, 0.16)',
        scrollThumbHover: 'rgba(255, 255, 255, 0.30)',
        tooltipBg: '#2e2e34',
        selectedPill: 'rgba(255, 255, 255, 0.09)',
        selectedPillHover: 'rgba(255, 255, 255, 0.13)',
      };

const lightColors = {
        primary: '#3b66f5',
        secondary: '#0d9488',
        bgDefault: '#fafafa',
        bgPaper: '#ffffff',
        sidebar: '#f4f4f5',
        divider: 'rgba(0, 0, 0, 0.08)',
        textPrimary: '#1c1c21',
        textSecondary: '#6e6e78',
        success: '#16a34a',
        warning: '#b07a10',
        error: '#dc2626',
        info: '#2563eb',
        scrollThumb: 'rgba(0, 0, 0, 0.18)',
        scrollThumbHover: 'rgba(0, 0, 0, 0.34)',
        tooltipBg: '#2e2e34',
        selectedPill: 'rgba(0, 0, 0, 0.07)',
        selectedPillHover: 'rgba(0, 0, 0, 0.10)',
      };

export function buildTheme(mode: 'light' | 'dark'): Theme {
  const dark = mode === 'dark';
  const c = dark ? darkColors : lightColors;

  return createTheme({
    palette: {
      mode,
      primary: { main: c.primary },
      secondary: { main: c.secondary },
      // Light mode pins the `dark` variants to hues that pass WCAG AA as
      // small text on the near-white backgrounds (see statusTextColor).
      success: { main: c.success, ...(dark ? {} : { dark: '#15803d' }) },
      warning: { main: c.warning, ...(dark ? {} : { dark: '#8f6209' }) },
      error: { main: c.error, ...(dark ? {} : { dark: '#b91c1c' }) },
      info: { main: c.info, ...(dark ? {} : { dark: '#1d4ed8' }) },
      divider: c.divider,
      sidebar: c.sidebar,
      background: { default: c.bgDefault, paper: c.bgPaper },
      // `disabled` is used as the dimmest text tier; keying it off the
      // secondary hue keeps the two muted greys in the same family instead
      // of MUI's unrelated default.
      text: { primary: c.textPrimary, secondary: c.textSecondary, disabled: alpha(c.textSecondary, dark ? 0.55 : 0.6) },
    },
    shape: { borderRadius: 8 },
    typography: {
      // Bundled variable font (see main.tsx) — variable weights make the
      // 550 emphasis tier real instead of snapping to 600.
      fontFamily: '"Inter Variable", "Inter", -apple-system, "Segoe UI", "Roboto", "Helvetica", "Arial", sans-serif',
      fontSize: 13,
      h5: { fontWeight: 600, letterSpacing: -0.2 },
      h6: { fontWeight: 600, letterSpacing: -0.2 },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { fontWeight: 550 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          '*': {
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.scrollThumb} transparent`,
          },
          '*::-webkit-scrollbar': { width: layout.scrollbarSize, height: layout.scrollbarSize },
          '*::-webkit-scrollbar-track': { background: 'transparent' },
          '*::-webkit-scrollbar-thumb': {
            backgroundColor: c.scrollThumb,
            borderRadius: 8,
            border: '2px solid transparent',
            backgroundClip: 'content-box',
            '&:hover': { backgroundColor: c.scrollThumbHover },
          },
          '*::-webkit-scrollbar-corner': { background: 'transparent' },
          '.kubus-usage': { width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 },
          '.kubus-usage-value': { fontSize: 12, fontWeight: 600, flexShrink: 0, minWidth: 44 },
          '.kubus-usage-track': { position: 'relative', display: 'block', flex: 1, minWidth: 36, height: 5, borderRadius: 999, backgroundColor: alpha(c.textPrimary, dark ? 0.08 : 0.04) },
          '.kubus-usage-empty': { opacity: 0.5 },
          '.kubus-usage-fill': {
            appearance: 'none', display: 'block', width: '100%', height: '100%', border: 0, borderRadius: 'inherit', background: 'transparent',
            '&::-webkit-progress-bar': { background: 'transparent', borderRadius: 'inherit' },
            '&::-webkit-progress-value': { background: 'currentColor', borderRadius: 'inherit' },
            '&::-moz-progress-bar': { background: 'currentColor', borderRadius: 'inherit' },
          },
          '.kubus-usage-success': { color: c.success },
          '.kubus-usage-warning': { color: c.warning },
          '.kubus-usage-error': { color: c.error },
          '.kubus-usage-marker': { position: 'absolute', top: -3, width: 2, height: 11, marginLeft: -1, borderRadius: 1, backgroundColor: c.textPrimary, boxShadow: `0 0 0 1px ${c.bgPaper}` },
          '.kubus-labels-cell': { display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, overflow: 'hidden' },
          '.kubus-labels-tooltip': { display: 'flex', flexWrap: 'wrap', gap: 4 },
          '.kubus-label-chip': { display: 'inline-block', boxSizing: 'border-box', maxWidth: 170, height: 20, padding: '0 7px', border: `1px solid ${alpha(c.textPrimary, 0.23)}`, borderRadius: 16, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 },
          'button.kubus-label-chip': { cursor: 'pointer', '&:hover': { backgroundColor: alpha(c.textPrimary, 0.08) }, '&:focus-visible': { outline: `2px solid ${c.primary}`, outlineOffset: -2 } },
          '.kubus-label-overflow': { borderColor: 'transparent', backgroundColor: alpha(c.textPrimary, 0.08) },
          '.kubus-grid-checkbox': {
            appearance: 'none', display: 'block', width: 18, height: 18, margin: 4,
            border: `2px solid ${c.textSecondary}`, borderRadius: 3, cursor: 'pointer',
            '&:checked, &:indeterminate': { borderColor: c.primary, backgroundColor: c.primary },
            '&:checked': { backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cpath fill=%22white%22 d=%22M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z%22/%3E%3C/svg%3E")' },
            '&:indeterminate': { backgroundImage: 'linear-gradient(white, white)', backgroundSize: '10px 2px', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
            '&:focus-visible': { outline: `2px solid ${c.primary}`, outlineOffset: 3 },
            '&:disabled': { opacity: 0.4, cursor: 'default' },
          },
          '.kubus-status': { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 550, lineHeight: 1.6, whiteSpace: 'nowrap' },
          '.kubus-status-md': { gap: 7, fontSize: 13 },
          '.kubus-status-dot': { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', backgroundColor: 'currentColor', flexShrink: 0 },
          '.kubus-status-md .kubus-status-dot': { width: 8, height: 8 },
          '.kubus-status-default': { color: c.textSecondary },
          '.kubus-status-default .kubus-status-dot': { opacity: 0.6 },
          '.kubus-status-success': { color: dark ? c.success : '#15803d' },
          '.kubus-status-error': { color: dark ? c.error : '#b91c1c' },
          '.kubus-status-warning, .kubus-ready-warning': { color: dark ? c.warning : '#8f6209' },
          '::selection': { backgroundColor: alpha(c.primary, 0.3) },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundColor: c.sidebar } },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiButton: {
        defaultProps: { size: 'small' },
        styleOverrides: { root: { textTransform: 'none', borderRadius: 7 } },
      },
      MuiToggleButton: {
        styleOverrides: { root: { textTransform: 'none', fontWeight: 550 } },
      },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: c.divider },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: alpha(c.primary, 0.5) },
          },
        },
      },
      MuiChip: {
        defaultProps: { size: 'small' },
        styleOverrides: { root: { fontWeight: 500 } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: {
          tooltip: { backgroundColor: c.tooltipBg, fontSize: 12, padding: '6px 10px', borderRadius: 6 },
          arrow: { color: c.tooltipBg },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: { borderRadius: 10, borderColor: c.divider },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 10,
            border: `1px solid ${c.divider}`,
            boxShadow: dark ? '0 8px 28px rgba(0, 0, 0, 0.5)' : '0 8px 28px rgba(0, 0, 0, 0.12)',
          },
        },
      },
      MuiAutocomplete: {
        styleOverrides: {
          paper: {
            borderRadius: 10,
            border: `1px solid ${c.divider}`,
            boxShadow: dark ? '0 8px 28px rgba(0, 0, 0, 0.5)' : '0 8px 28px rgba(0, 0, 0, 0.12)',
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 12,
            border: `1px solid ${c.divider}`,
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 550,
            minHeight: 40,
            color: c.textSecondary,
            '&.Mui-selected': { color: c.textPrimary },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: { height: 2, borderRadius: '2px 2px 0 0', backgroundColor: c.textPrimary },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            margin: '1px 6px',
            '&:hover': { backgroundColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' },
            '&.Mui-selected': {
              backgroundColor: c.selectedPill,
              '&:hover': { backgroundColor: c.selectedPillHover },
              '& .MuiListItemText-primary': { fontWeight: 600, color: c.textPrimary },
              '& .MuiListItemIcon-root': { color: c.textPrimary },
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderBottomColor: c.divider },
          head: {
            fontWeight: 550,
            fontSize: 12,
            color: c.textSecondary,
          },
        },
      },
      MuiDataGrid: {
        styleOverrides: {
          root: {
            border: 'none',
            '--DataGrid-rowBorderColor': c.divider,
            '--DataGrid-containerBackground': 'transparent',
            '& .MuiDataGrid-columnHeaderTitle': {
              fontWeight: 550,
              fontSize: 12,
              color: c.textSecondary,
            },
            '& .MuiDataGrid-columnSeparator': { color: 'transparent' },
            // No outline for mouse focus, but keyboard navigation must show
            // which cell is focused (source order: focus-visible wins).
            '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
            '& .MuiDataGrid-cell:focus-visible, & .MuiDataGrid-columnHeader:focus-visible': {
              outline: `2px solid ${alpha(c.primary, 0.8)}`,
              outlineOffset: '-2px',
            },
            // Keep each virtual row's raster stable when its render zone moves.
            '& .MuiDataGrid-row': { transform: 'translateZ(0)' },
            '& .MuiDataGrid-row:hover': { backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' },
            '& .MuiDataGrid-row.Mui-selected': {
              backgroundColor: c.selectedPill,
              '&:hover': { backgroundColor: c.selectedPillHover },
            },
            '& .MuiDataGrid-footerContainer': { borderTopColor: c.divider },
          },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { borderRadius: 3, backgroundColor: alpha(c.textSecondary, 0.15) },
        },
      },
      MuiAlert: {
        styleOverrides: { root: { borderRadius: 8 } },
      },
    },
  });
}
