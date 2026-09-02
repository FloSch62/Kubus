import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { AgeCell } from '../AgeCell.js';

export interface ProblemItem {
  /** Bold headline, e.g. "worker: CrashLoopBackOff" or "FailedScheduling". */
  title: string;
  message?: string;
  /** Occurrence count (events), rendered as ×N. */
  count?: number;
  /** When it last happened (events). */
  at?: string;
}

/**
 * The `kubectl describe` answer to "why isn't this healthy": failing
 * conditions, container states and recent warnings at the top of an
 * overview, in full, instead of truncated table cells and a separate tab.
 */
export function ProblemBanner({ severity, title, items }: { severity: 'warning' | 'error'; title: string; items: ProblemItem[] }) {
  if (!items.length) return null;
  return (
    <Alert severity={severity} sx={{ '& .MuiAlert-message': { minWidth: 0, flex: 1 } }}>
      <AlertTitle>{title}</AlertTitle>
      <Stack spacing={0.75}>
        {items.map((item, i) => (
          <Box key={`${item.title}:${i}`}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {item.title}
              {item.count !== undefined && item.count > 1 ? ` ×${item.count}` : ''}
              {item.at && (
                <>
                  {' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    <AgeCell timestamp={item.at} variant="caption" /> ago
                  </Typography>
                </>
              )}
            </Typography>
            {item.message && (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {item.message}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Alert>
  );
}
