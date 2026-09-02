import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { statusTextColor } from '../../theme.js';

/**
 * Label→value rows for a resource's key facts — the summary block at the top
 * of every detail overview. Values read as a scannable column; chips are
 * reserved for genuine tags (labels, selectors), not facts.
 */
export function Facts({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(110px, 150px) 1fr',
        columnGap: 2,
        rowGap: 0.75,
        alignItems: 'baseline',
      }}
    >
      {children}
    </Box>
  );
}

/** One fact row. Renders nothing when the value is empty, so callers can pass
 *  optional fields straight through without conditionals. */
export function Fact({ label, hint, mono, children }: { label: string; hint?: string; mono?: boolean; children: ReactNode }) {
  if (children === undefined || children === null || children === '' || children === false) return null;
  const labelNode = (
    <Typography
      variant="body2"
      color="text.secondary"
      noWrap
      sx={hint ? { textDecoration: 'underline dotted', textDecorationColor: 'text.disabled', textUnderlineOffset: 3, cursor: 'help' } : undefined}
    >
      {label}
    </Typography>
  );
  return (
    <>
      {hint ? <Tooltip title={hint}>{labelNode}</Tooltip> : labelNode}
      <Box
        sx={{
          typography: 'body2',
          minWidth: 0,
          wordBreak: 'break-word',
          ...(mono ? { fontFamily: 'monospace', fontSize: 12 } : {}),
        }}
      >
        {children}
      </Box>
    </>
  );
}

/** Warning-toned fact value for a non-default state worth noticing (Paused, Immutable). */
export function WarnValue({ children }: { children: string }) {
  return (
    <Box component="span" sx={{ fontWeight: 550, color: statusTextColor('warning') }}>
      {children}
    </Box>
  );
}

/** Fact value that navigates — related resources, backing objects. */
export function FactLink({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <Link
      component="button"
      variant="body2"
      underline="hover"
      title={title}
      onClick={onClick}
      sx={{ textAlign: 'left', wordBreak: 'break-word', verticalAlign: 'baseline' }}
    >
      {children}
    </Link>
  );
}
