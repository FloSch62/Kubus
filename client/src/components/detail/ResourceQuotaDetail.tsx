import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { parseQuantity } from '../../kube-display.js';
import { statusTextColor } from '../../theme.js';
import { usageColor } from '../UsageMeter.js';
import { KeyValueSection, MetadataSection } from './GenericDetail.js';
import { Fact, Facts } from './Facts.js';
import { ProblemBanner } from './ProblemBanner.js';
import { DetailStack, Section } from './Section.js';
import { SummaryStrip } from './SummaryStrip.js';

interface QuotaSpec {
  hard?: Record<string, string>;
  scopes?: string[];
  scopeSelector?: { matchExpressions?: Array<{ scopeName?: string; operator?: string; values?: string[] }> };
}

interface QuotaStatus {
  hard?: Record<string, string>;
  used?: Record<string, string>;
}

export interface QuotaRow {
  resource: string;
  used: string;
  hard: string;
  /** used/hard as 0..100+, undefined when the hard limit is zero or unparsable. */
  pct?: number;
}

/** Rows sorted so the tightest resources come first. */
export function quotaRows(obj: KubeObject): QuotaRow[] {
  const spec = (obj.spec ?? {}) as QuotaSpec;
  const status = (obj.status ?? {}) as QuotaStatus;
  const hard = status.hard ?? spec.hard ?? {};
  return Object.entries(hard)
    .map(([resource, limit]) => {
      const hardVal = parseQuantity(limit);
      const used = status.used?.[resource] ?? '0';
      return { resource, used, hard: limit, pct: hardVal > 0 ? (parseQuantity(used) / hardVal) * 100 : undefined };
    })
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.resource.localeCompare(b.resource));
}

/**
 * Used against hard, per resource, as bars — the quota page that answers
 * "why is it Pending / why was the create rejected" at a glance. Exhausted
 * resources lead and get a banner.
 */
export function ResourceQuotaDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = (obj.spec ?? {}) as QuotaSpec;
  const rows = quotaRows(obj);
  const exhausted = rows.filter((r) => (r.pct ?? 0) >= 100);
  const near = rows.filter((r) => (r.pct ?? 0) >= 90 && (r.pct ?? 0) < 100);
  const scopes = spec.scopes ?? [];
  const scopeExpressions = spec.scopeSelector?.matchExpressions ?? [];
  const worst = rows[0]?.pct;

  return (
    <DetailStack>
      <SummaryStrip
        items={[
          { label: 'Resources', value: String(rows.length), hint: 'Resource names this quota constrains.' },
          { label: 'Exhausted', value: String(exhausted.length), tone: exhausted.length ? 'error' : 'success', hint: 'Resources at or over their hard limit — new objects needing them are rejected.' },
          { label: 'Near limit', value: String(near.length), tone: near.length ? 'warning' : undefined, hint: 'Resources at 90% or more.' },
          { label: 'Highest use', value: worst !== undefined ? `${worst.toFixed(0)}%` : '—', tone: worst === undefined ? undefined : usageColor(worst) },
        ]}
      />
      {exhausted.length > 0 && (
        <ProblemBanner
          severity="error"
          title="Quota exhausted"
          items={exhausted.map((r) => ({
            title: `${r.resource}: ${r.used} of ${r.hard}`,
            message: 'Creating anything that needs this resource in the namespace fails with "exceeded quota" until usage drops or the limit is raised.',
          }))}
        />
      )}
      <Section title="Usage" count={rows.length} flush>
        {rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
            No hard limits are set.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Resource</TableCell>
                <TableCell sx={{ width: '40%' }}>Used</TableCell>
                <TableCell align="right">Used / hard</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.resource}>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{r.resource}</TableCell>
                  <TableCell>
                    {r.pct !== undefined ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <LinearProgress variant="determinate" value={Math.min(100, r.pct)} color={usageColor(r.pct)} sx={{ flex: 1, height: 6, borderRadius: 3, bgcolor: 'action.hover' }} />
                        <Typography variant="caption" sx={{ width: 42, textAlign: 'right', fontWeight: 600, color: r.pct >= 90 ? statusTextColor(r.pct >= 100 ? 'error' : 'warning') : 'text.secondary' }}>
                          {r.pct.toFixed(0)}%
                        </Typography>
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.disabled">
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }}>
                    {r.used} / {r.hard}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      {(scopes.length > 0 || scopeExpressions.length > 0) && (
        <Section title="Scopes" description="the quota only counts objects matching these scopes">
          <Facts>
            <Fact label="Scopes">{scopes.join(', ')}</Fact>
            {scopeExpressions.map((expr, i) => (
              <Fact key={i} label={expr.scopeName ?? `scope ${i + 1}`}>
                {`${expr.operator ?? 'Exists'}${expr.values?.length ? ` ${expr.values.join(', ')}` : ''}`}
              </Fact>
            ))}
          </Facts>
        </Section>
      )}
      <KeyValueSection title="Labels" entries={obj.metadata.labels} />
      <KeyValueSection title="Annotations" entries={obj.metadata.annotations} defaultOpen={false} />
      <MetadataSection obj={obj} ctx={ctx} defaultOpen={false} />
    </DetailStack>
  );
}
