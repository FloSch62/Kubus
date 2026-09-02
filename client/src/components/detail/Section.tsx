import { useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

/** Object form of sx — the only shape these helpers merge into their own styles. */
type SxObject = Exclude<SxProps<Theme>, ReadonlyArray<unknown> | ((theme: Theme) => unknown)>;
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

/** Small rounded counter used next to section titles and detail toggles. */
export function CountPill({ value, sx }: { value: number | string; sx?: SxObject }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 20,
        height: 18,
        px: 0.75,
        borderRadius: 999,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        ...sx,
      }}
    >
      {value}
    </Box>
  );
}

/** Vertical rhythm for a detail overview: summary first, then section cards. */
export function DetailStack({ children, sx }: { children: ReactNode; sx?: SxObject }) {
  return (
    <Stack spacing={1.5} sx={{ p: 2, ...sx }}>
      {children}
    </Stack>
  );
}

/**
 * Collapsible detail-view section rendered as a soft outlined card: a
 * clickable header (title, count, one-line summary, optional controls) and a
 * body. `flush` drops the body padding so tables and row lists run edge to
 * edge and read as part of the card.
 */
export function Section({
  title,
  count,
  description,
  defaultOpen = true,
  actions,
  flush = false,
  children,
}: {
  title: string;
  /** Item count shown next to the title (e.g. containers, labels). */
  count?: number;
  /** One-line summary shown muted next to the title, visible while collapsed. */
  description?: ReactNode;
  defaultOpen?: boolean;
  /** Right-aligned header controls; clicking them doesn't toggle. */
  actions?: ReactNode;
  /** Body without padding — for tables and row lists. */
  flush?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Callers pass live values (e.g. conditions collapse while healthy). When
  // the value flips on a later render — a node turning unhealthy in an open
  // drawer — follow it; between flips, manual toggles win.
  const prevDefault = useRef(defaultOpen);
  if (prevDefault.current !== defaultOpen) {
    prevDefault.current = defaultOpen;
    if (open !== defaultOpen) setOpen(defaultOpen);
  }
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}>
      <Stack direction="row" sx={{ alignItems: 'center', minHeight: 38, pr: actions ? 1 : 0 }}>
        <ButtonBase
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          sx={{
            flex: 1,
            minWidth: 0,
            alignSelf: 'stretch',
            justifyContent: 'flex-start',
            alignItems: 'center',
            gap: 0.75,
            px: 1.25,
            py: 0.75,
            textAlign: 'left',
            borderRadius: 1.5,
            ...(open && { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }),
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <KeyboardArrowRightIcon
            sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
          />
          <Typography variant="subtitle2" noWrap sx={{ flexShrink: 0 }}>
            {title}
          </Typography>
          {count !== undefined && <CountPill value={count} />}
          {description && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: 0.5, minWidth: 0 }}>
              {description}
            </Typography>
          )}
        </ButtonBase>
        {actions}
      </Stack>
      <Collapse in={open} timeout={150} unmountOnExit>
        <Box
          sx={{
            borderTop: '1px solid',
            borderColor: 'divider',
            p: flush ? 0 : 1.5,
            // Edge-to-edge tables: the card border already closes the list, and a
            // table wider than the drawer scrolls inside the card.
            ...(flush && { overflowX: 'auto', borderBottomLeftRadius: 12, borderBottomRightRadius: 12, '& .MuiTableRow-root:last-child .MuiTableCell-body': { borderBottom: 0 } }),
          }}
        >
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}
