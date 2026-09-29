import { memo } from 'react';
import { useTheme } from '@mui/material/styles';
import { clusterTagColors, shortContextName } from '../cluster-color.js';

/**
 * A cluster as a short colored tag (`kind-kubus-a` → `kubus-a`), used where
 * rows from several clusters share one list. The full context name is the
 * tooltip; `colorIndex` comes from clusterColorIndexes so neighbours differ.
 */
export const ClusterTag = memo(function ClusterTag({ ctx, colorIndex }: { ctx: string; colorIndex: number }) {
  const mode = useTheme().palette.mode;
  const { fg, bg } = clusterTagColors(colorIndex, mode);
  return (
    <span
      title={ctx}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: '100%',
        minWidth: 0,
        height: 20,
        padding: '0 7px 0 6px',
        borderRadius: 5,
        background: bg,
        color: fg,
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: '20px',
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 2, background: fg, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{shortContextName(ctx)}</span>
    </span>
  );
});
