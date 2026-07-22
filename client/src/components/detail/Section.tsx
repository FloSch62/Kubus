import { useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

/** Collapsible detail-view section with a clickable subtitle header. */
export function Section({
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  /** Item count shown next to the title (e.g. containers, labels). */
  count?: number;
  defaultOpen?: boolean;
  /** Right-aligned header controls; clicking them doesn't toggle. */
  actions?: ReactNode;
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
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', minHeight: 28 }}>
        <ButtonBase
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          sx={{
            flex: 1,
            justifyContent: 'flex-start',
            alignItems: 'center',
            borderRadius: 1,
            minHeight: 28,
            px: 0.5,
            ml: -0.5,
            textAlign: 'left',
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <KeyboardArrowRightIcon
            sx={{ fontSize: 18, mr: 0.25, color: 'text.secondary', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
          />
          <Typography variant="subtitle2">{title}</Typography>
          {count !== undefined && (
            <Typography variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
              {count}
            </Typography>
          )}
        </ButtonBase>
        {actions}
      </Stack>
      <Collapse in={open} timeout={150} unmountOnExit>
        <Box sx={{ pt: 0.5 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}
