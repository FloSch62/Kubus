import { Fragment } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { pluralLabel, type InventoryHealth, type NamespaceInventoryEntry, type NamespaceQuotaStatus } from '@kubus/shared';
import { statusTextColor } from '../../theme.js';
import { usageColor } from '../UsageMeter.js';

const SEGMENTS = [
  { key: 'healthy', color: 'success.main' },
  { key: 'degraded', color: 'warning.main' },
  { key: 'failed', color: 'error.main' },
] as const;

/** "4 healthy, 1 degraded, 2 failed", zero parts left out. */
export function healthSummary(health: InventoryHealth): string {
  const parts = SEGMENTS.filter((s) => health[s.key] > 0).map((s) => `${health[s.key]} ${s.key}`);
  return parts.length ? parts.join(', ') : 'none';
}

/**
 * Segmented healthy / degraded / failed bar. Segments grow with their share
 * but keep a minimum width, so one failure among fifty still shows. It is
 * decoration: the owner carries the same split as text or label.
 */
export function HealthBar({ health }: { health: InventoryHealth }) {
  const shown = SEGMENTS.filter((s) => health[s.key] > 0);
  if (!shown.length) return null;
  return (
    <Box component="span" aria-hidden sx={{ display: 'flex', gap: '2px', height: 6, borderRadius: 3, overflow: 'hidden' }}>
      {shown.map((s) => (
        <Box key={s.key} component="span" sx={{ flexGrow: health[s.key], flexBasis: 0, minWidth: 6, bgcolor: s.color }} />
      ))}
    </Box>
  );
}

/**
 * The namespace inventory: one tile per kind with objects in it (count plus
 * a health bar where the kind has a notion of health), custom resources
 * apart, and the empty kinds as a compact line of links. Every entry opens
 * that kind's list through `onOpen`.
 */
export function InventoryGrid({ inventory, onOpen }: { inventory: NamespaceInventoryEntry[]; onOpen: (entry: NamespaceInventoryEntry) => void }) {
  const shown = inventory.filter((e) => e.total > 0 || e.unavailable);
  const builtin = shown.filter((e) => !e.custom);
  const custom = shown.filter((e) => e.custom);
  const empty = inventory.filter((e) => e.total === 0 && !e.unavailable);
  return (
    <Box>
      {builtin.length > 0 && <TileGrid entries={builtin} onOpen={onOpen} />}
      {custom.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: builtin.length ? 1.5 : 0, mb: 0.75 }}>
            Custom resources
          </Typography>
          <TileGrid entries={custom} onOpen={onOpen} />
        </>
      )}
      {shown.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing in this namespace yet.
        </Typography>
      )}
      {empty.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.25, mb: 0, lineHeight: 1.8 }}>
          Empty:{' '}
          {empty.map((e, i) => (
            <Fragment key={`${e.group}/${e.plural}`}>
              {i > 0 && ', '}
              <Link component="button" variant="caption" color="inherit" underline="hover" onClick={() => onOpen(e)} sx={{ verticalAlign: 'baseline' }}>
                {pluralLabel(e.kind)}
              </Link>
            </Fragment>
          ))}
        </Typography>
      )}
    </Box>
  );
}

function TileGrid({ entries, onOpen }: { entries: NamespaceInventoryEntry[]; onOpen: (entry: NamespaceInventoryEntry) => void }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: 1 }}>
      {entries.map((e) => (
        <InventoryTile key={`${e.group}/${e.plural}`} entry={e} onOpen={onOpen} />
      ))}
    </Box>
  );
}

function InventoryTile({ entry, onOpen }: { entry: NamespaceInventoryEntry; onOpen: (entry: NamespaceInventoryEntry) => void }) {
  const label = pluralLabel(entry.kind);
  const health = entry.unavailable ? undefined : entry.health;
  const failed = health?.failed ?? 0;
  const degraded = health?.degraded ?? 0;
  const apiVersion = entry.group ? `${entry.group}/${entry.version}` : entry.version;
  return (
    <ButtonBase
      onClick={() => onOpen(entry)}
      aria-label={`${label}: ${entry.unavailable ? 'unavailable' : entry.total}${health ? `, ${healthSummary(health)}` : ''}`}
      title={health ? `${apiVersion} · ${healthSummary(health)}` : apiVersion}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        gap: 0.75,
        px: 1.25,
        py: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        textAlign: 'left',
        '&:hover': { bgcolor: 'action.hover', borderColor: 'primary.main' },
      }}
    >
      <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography component="span" variant="body2" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {label}
        </Typography>
        {entry.unavailable ? (
          <Typography component="span" variant="body2" color="text.disabled">
            —
          </Typography>
        ) : (
          <Typography component="span" variant="body2" sx={{ fontWeight: 700 }}>
            {entry.total}
          </Typography>
        )}
      </Box>
      {health && <HealthBar health={health} />}
      {entry.unavailable && (
        <Typography component="span" variant="caption" color="text.secondary">
          No access or API not served
        </Typography>
      )}
      {(failed > 0 || degraded > 0) && (
        <Typography component="span" variant="caption" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
          {failed > 0 && <Box component="span" sx={{ color: statusTextColor('error') }}>{failed} failed</Box>}
          {failed > 0 && degraded > 0 && ' · '}
          {degraded > 0 && <Box component="span" sx={{ color: statusTextColor('warning') }}>{degraded} degraded</Box>}
        </Typography>
      )}
    </ButtonBase>
  );
}

/**
 * Used against hard per quota resource as bars. `onOpen` opens the quota
 * object itself.
 */
export function QuotaUsageList({ quotas, onOpen }: { quotas: NamespaceQuotaStatus[]; onOpen: (quota: NamespaceQuotaStatus) => void }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {quotas.map((q) => (
        <Box key={q.name}>
          <Link component="button" variant="body2" underline="hover" onClick={() => onOpen(q)} sx={{ fontWeight: 600, mb: 0.5, display: 'block', textAlign: 'left' }}>
            {q.name}
          </Link>
          {q.resources.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No hard limits are set.
            </Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) minmax(80px, 1fr) max-content', columnGap: 2, rowGap: 0.5, alignItems: 'center' }}>
              {q.resources.map((r) => (
                <Fragment key={r.resource}>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                    {r.resource}
                  </Typography>
                  {r.pct !== undefined ? (
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, r.pct)}
                      color={usageColor(r.pct)}
                      aria-label={`${r.resource} ${r.pct.toFixed(0)}% used`}
                      sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover' }}
                    />
                  ) : (
                    <Box />
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.used} / {r.hard}
                    {r.pct !== undefined && (
                      <Box component="span" sx={{ fontWeight: 600, color: r.pct >= 90 ? statusTextColor(r.pct >= 100 ? 'error' : 'warning') : 'inherit' }}>
                        {` (${r.pct.toFixed(0)}%)`}
                      </Box>
                    )}
                  </Typography>
                </Fragment>
              ))}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
