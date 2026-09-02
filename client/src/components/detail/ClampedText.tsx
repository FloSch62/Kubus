import { useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Long free text (state messages, condition messages) clamped to a few lines
 * with an inline "Show more" once it actually overflows — so a two-line
 * message reads whole, and a wall of text stays out of the way until asked.
 */
export function ClampedText({ text, lines = 3, sx }: { text: string; lines?: number; sx?: SxProps<Theme> }) {
  const ref = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    // Drawer resizes change the wrap point.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(check);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [text, lines, expanded]);

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        ref={ref}
        sx={[
          {
            typography: 'body2',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        {text}
      </Box>
      {(overflowing || expanded) && (
        <Link component="button" variant="caption" underline="hover" onClick={() => setExpanded((v) => !v)} sx={{ display: 'block', mt: 0.25, fontWeight: 550 }}>
          {expanded ? 'Show less' : 'Show more'}
        </Link>
      )}
    </Box>
  );
}
