import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { statusTextColor } from '../../theme.js';

export type SummaryTone = 'success' | 'warning' | 'error' | 'info';

export interface SummaryItem {
  label: string;
  value: ReactNode;
  /** Colors the value — reserved for health-bearing numbers (ready counts, endpoints). */
  tone?: SummaryTone;
  /** Explains the label on hover. */
  hint?: string;
  /** Addresses, selectors and other machine strings. */
  mono?: boolean;
  /** Full text for the tooltip/title when the value may truncate. */
  title?: string;
  /** Grid columns to take — for values that need the room (node names). */
  span?: number;
}

/**
 * The headline numbers of a resource as a row of soft tiles — the answer to
 * "how is it doing" before any section is opened. Values are kept to one
 * line so the strip scans left to right; anything longer belongs in a
 * Details section.
 */
export function SummaryStrip({ items }: { items: Array<SummaryItem | false | null | undefined> }) {
  const shown = items.filter((i): i is SummaryItem => !!i);
  if (!shown.length) return null;
  return (
    <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gridAutoFlow: 'dense', gap: 1, m: 0 }}>
      {shown.map((item) => {
        const label = (
          <Typography
            component="dt"
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{
              display: 'block',
              lineHeight: 1.4,
              ...(item.hint && { textDecoration: 'underline dotted', textDecorationColor: 'text.disabled', textUnderlineOffset: 3, cursor: 'help', width: 'fit-content', maxWidth: '100%' }),
            }}
          >
            {item.label}
          </Typography>
        );
        return (
          <Box
            key={item.label}
            sx={{ minWidth: 0, px: 1.5, py: 1, borderRadius: 1.5, bgcolor: 'action.hover', ...(item.span && { gridColumn: `span ${item.span}` }) }}
          >
            {item.hint ? <Tooltip title={item.hint}>{label}</Tooltip> : label}
            <Typography
              component="dd"
              noWrap
              title={item.title ?? (typeof item.value === 'string' ? item.value : undefined)}
              sx={{
                m: 0,
                mt: 0.25,
                fontSize: item.mono ? 13 : 15,
                fontWeight: 600,
                lineHeight: 1.35,
                minWidth: 0,
                ...(item.mono && { fontFamily: 'monospace' }),
                color: item.tone ? statusTextColor(item.tone) : 'text.primary',
              }}
            >
              {item.value ?? '—'}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}
