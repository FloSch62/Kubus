import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

/**
 * Bulk actions for the checked rows of a list, on their own row under the
 * filter bar so they never push the page's own buttons around.
 */
export function SelectionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  return (
    <Box
      component="section"
      aria-label="Selected rows"
      sx={{
        mx: 1.5,
        mb: 1,
        px: 1.25,
        py: 0.75,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1,
        flexShrink: 0,
        borderRadius: 1,
        border: 1,
        borderColor: (t) => alpha(t.palette.primary.main, 0.35),
        bgcolor: (t) => alpha(t.palette.primary.main, t.palette.mode === 'dark' ? 0.12 : 0.06),
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, mr: 0.5 }}>
        {count} selected
      </Typography>
      {children}
      <Box sx={{ flex: 1 }} />
      <Button size="small" color="inherit" onClick={onClear}>
        Clear selection
      </Button>
    </Box>
  );
}
