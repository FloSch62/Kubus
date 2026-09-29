import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { TruncationTooltip } from './truncation.js';

export interface UsageRankingRow {
  key: string;
  /** Main label (a pod or namespace name). */
  name: string;
  /** Muted line under the name (its namespace, a pod count). */
  detail?: string;
  /** Bar segments, drawn left to right in `colors` order; their sum is the row's total. */
  values: number[];
  /** Share of the whole (0..1), shown after the value, e.g. of cluster capacity. */
  share?: number;
}

function formatShare(share: number): string {
  const pct = share * 100;
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * A ranked list read as label, bar and value: the name stays whole (it is
 * the thing you look for), the bar compares rows against the busiest one and
 * the value is printed, so no axis is needed.
 */
export function UsageRanking({
  rows,
  colors,
  format,
  empty = 'No data yet.',
}: {
  rows: UsageRankingRow[];
  colors: string[];
  format: (value: number) => string;
  empty?: string;
}) {
  if (!rows.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        {empty}
      </Typography>
    );
  }
  const max = Math.max(...rows.map((r) => r.values.reduce((a, b) => a + b, 0)), 0);
  return (
    <Box
      component="ul"
      sx={{
        listStyle: 'none',
        m: 0,
        p: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.7fr) minmax(64px, 1.5fr) auto',
        columnGap: 1.5,
        rowGap: 1,
        alignItems: 'center',
        pt: 0.5,
      }}
    >
      {rows.map((row) => {
        const total = row.values.reduce((a, b) => a + b, 0);
        return (
          <Box component="li" key={row.key} sx={{ display: 'contents' }}>
            <Box sx={{ minWidth: 0 }}>
              <TruncationTooltip text={row.name}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                  {row.name}
                </Typography>
              </TruncationTooltip>
              {row.detail && (
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', lineHeight: 1.3 }}>
                  {row.detail}
                </Typography>
              )}
            </Box>
            <Box
              aria-hidden
              sx={(theme) => ({
                height: 10,
                borderRadius: 0.75,
                bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.08 : 0.05),
                display: 'flex',
                overflow: 'hidden',
              })}
            >
              {row.values.map((v, i) => (
                <Box key={i} sx={{ width: `${max > 0 ? (v / max) * 100 : 0}%`, bgcolor: colors[i % colors.length], minWidth: v > 0 ? 2 : 0 }} />
              ))}
            </Box>
            <Box sx={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
              <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
                {format(total)}
              </Typography>
              {row.share !== undefined && (
                <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 0.75, display: 'inline-block', minWidth: 38 }}>
                  {formatShare(row.share)}
                </Typography>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
