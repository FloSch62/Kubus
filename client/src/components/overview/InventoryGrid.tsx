import { Fragment, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { pluralLabel, type InventoryHealth, type NamespaceInventoryEntry, type NamespaceQuotaStatus } from '@kubus/shared';
import { statusTextColor } from '../../theme.js';
import { usageColor } from '../UsageMeter.js';
import { InventoryButton, InventoryRow } from './Attention.js';
import { kindIcon } from './kind-icons.js';

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

/** "2 failed" (red) or "1 degraded" (amber) for an inventory button, failures first. */
function problemOf(health: InventoryHealth | undefined): { text: string; tone: 'error' | 'warning' } | undefined {
  if (!health) return undefined;
  if (health.failed > 0) return { text: health.degraded > 0 ? `${health.failed} failed · ${health.degraded} degraded` : `${health.failed} failed`, tone: 'error' };
  if (health.degraded > 0) return { text: `${health.degraded} degraded`, tone: 'warning' };
  return undefined;
}

/**
 * The namespace inventory: one compact button per kind with objects in it
 * (count, plus failed/degraded counts where the kind has a notion of
 * health), custom resources apart, and the empty kinds behind a toggle.
 * Every entry opens that kind's list through `onOpen`.
 */
export function InventoryGrid({ inventory, onOpen }: { inventory: NamespaceInventoryEntry[]; onOpen: (entry: NamespaceInventoryEntry) => void }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const shown = inventory.filter((e) => e.total > 0 || e.unavailable);
  const builtin = shown.filter((e) => !e.custom);
  const custom = shown.filter((e) => e.custom);
  const empty = inventory.filter((e) => e.total === 0 && !e.unavailable);
  return (
    <Box>
      {builtin.length > 0 && <ButtonRow entries={builtin} onOpen={onOpen} />}
      {custom.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: builtin.length ? 1.25 : 0, mb: 0.5 }}>
            Custom resources
          </Typography>
          <ButtonRow entries={custom} onOpen={onOpen} />
        </>
      )}
      {shown.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing in this namespace yet.
        </Typography>
      )}
      {empty.length > 0 && (
        <Box sx={{ mt: 0.75 }}>
          <Button size="small" onClick={() => setShowEmpty((v) => !v)} aria-expanded={showEmpty} sx={{ ml: -0.75, color: 'text.secondary' }}>
            {showEmpty ? 'Hide empty kinds' : `Show ${empty.length} empty ${empty.length === 1 ? 'kind' : 'kinds'}`}
          </Button>
          {showEmpty && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.25, mb: 0, lineHeight: 1.8 }}>
              {empty.map((e, i) => (
                <Fragment key={`${e.group}/${e.plural}`}>
                  {i > 0 && ', '}
                  <Link component="button" variant="caption" underline="hover" onClick={() => onOpen(e)} sx={{ verticalAlign: 'baseline' }}>
                    {pluralLabel(e.kind)}
                  </Link>
                </Fragment>
              ))}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

function ButtonRow({ entries, onOpen }: { entries: NamespaceInventoryEntry[]; onOpen: (entry: NamespaceInventoryEntry) => void }) {
  return (
    <InventoryRow>
      {entries.map((entry) => {
        const label = pluralLabel(entry.kind);
        const health = entry.unavailable ? undefined : entry.health;
        const apiVersion = entry.group ? `${entry.group}/${entry.version}` : entry.version;
        return (
          <InventoryButton
            key={`${entry.group}/${entry.plural}`}
            icon={kindIcon(entry.custom ? '' : entry.kind)}
            label={label}
            value={entry.unavailable ? undefined : entry.total}
            sub={entry.unavailable ? 'no access' : undefined}
            problem={problemOf(health)}
            title={health ? `${apiVersion} · ${healthSummary(health)}` : entry.unavailable ? `${apiVersion} · no access or API not served` : apiVersion}
            ariaLabel={`${label}: ${entry.unavailable ? 'unavailable' : entry.total}${health ? `, ${healthSummary(health)}` : ''}`}
            onClick={() => onOpen(entry)}
          />
        );
      })}
    </InventoryRow>
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
