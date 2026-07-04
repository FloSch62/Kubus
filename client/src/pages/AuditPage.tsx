import { useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { AuditFinding, AuditSeverity } from '@kubus/shared';
import { useAudit } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import { useDetailStore } from '../state/detail.js';
import { useAuditPrefsStore } from '../state/audit.js';
import { EmptyState } from '../components/EmptyState.js';

const SEVERITIES: AuditSeverity[] = ['critical', 'high', 'medium', 'low'];

const SEVERITY_COLOR: Record<AuditSeverity, 'error' | 'warning' | 'info' | 'default'> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

interface CheckGroup {
  checkId: string;
  severity: AuditSeverity;
  category: string;
  title: string;
  remediation: string;
  findings: AuditFinding[];
}

function groupByCheck(findings: AuditFinding[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup>();
  for (const f of findings) {
    const group = groups.get(f.checkId);
    if (group) group.findings.push(f);
    else groups.set(f.checkId, { checkId: f.checkId, severity: f.severity, category: f.category, title: f.title, remediation: f.remediation, findings: [f] });
  }
  return [...groups.values()];
}

function downloadFile(name: string, mime: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Minimal SARIF 2.1.0 export — one rule per check, one result per finding. */
function toSarif(findings: AuditFinding[]): string {
  const level: Record<AuditSeverity, string> = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };
  const rules = groupByCheck(findings).map((g) => ({
    id: g.checkId,
    shortDescription: { text: g.title },
    help: { text: g.remediation },
    properties: { category: g.category, severity: g.severity },
  }));
  const results = findings.map((f) => ({
    ruleId: f.checkId,
    level: level[f.severity],
    message: { text: `${f.resource.kind}/${f.resource.namespace ? `${f.resource.namespace}/` : ''}${f.resource.name} (${f.resource.ctx}): ${f.message}` },
    locations: [
      {
        logicalLocations: [{ fullyQualifiedName: `${f.resource.ctx}/${f.resource.namespace ?? ''}/${f.resource.kind}/${f.resource.name}` }],
      },
    ],
  }));
  return JSON.stringify(
    {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'Kubus Security Audit', rules } }, results }],
    },
    null,
    2,
  );
}

export function AuditPage() {
  const selected = useClustersStore((s) => s.selected);
  const { data, isLoading, isFetching } = useAudit(selected);
  const queryClient = useQueryClient();
  const openDetail = useDetailStore((s) => s.open);
  const { dismissedChecks, dismissCheck, restoreCheck } = useAuditPrefsStore();
  const [severityFilter, setSeverityFilter] = useState<ReadonlySet<AuditSeverity>>(new Set());
  const [textFilter, setTextFilter] = useState('');

  const reports = useMemo(() => (data ?? []).filter((r) => r.report), [data]);
  const failures = useMemo(() => (data ?? []).filter((r) => r.error), [data]);
  const allFindings = useMemo(() => reports.flatMap((r) => r.report!.findings), [reports]);

  const activeFindings = useMemo(() => {
    const dismissed = new Set(dismissedChecks);
    let out = allFindings.filter((f) => !dismissed.has(f.checkId));
    if (severityFilter.size) out = out.filter((f) => severityFilter.has(f.severity));
    const q = textFilter.trim().toLowerCase();
    if (q) {
      out = out.filter((f) =>
        [f.title, f.message, f.checkId, f.category, f.resource.name, f.resource.namespace ?? '', f.resource.kind, f.resource.ctx].join(' ').toLowerCase().includes(q),
      );
    }
    return out;
  }, [allFindings, dismissedChecks, severityFilter, textFilter]);

  const severityCounts = useMemo(() => {
    const dismissed = new Set(dismissedChecks);
    const counts: Record<AuditSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of allFindings) if (!dismissed.has(f.checkId)) counts[f.severity] += 1;
    return counts;
  }, [allFindings, dismissedChecks]);

  const groups = useMemo(() => groupByCheck(activeFindings), [activeFindings]);
  const dismissedWithCounts = useMemo(() => {
    const byCheck = new Map<string, number>();
    for (const f of allFindings) byCheck.set(f.checkId, (byCheck.get(f.checkId) ?? 0) + 1);
    return dismissedChecks.map((id) => ({ id, count: byCheck.get(id) ?? 0 }));
  }, [dismissedChecks, allFindings]);

  const totalScanned = reports.reduce((sum, r) => sum + (r.report?.stats.resourcesScanned ?? 0), 0);
  const checksRun = reports[0]?.report?.stats.checksRun ?? 0;
  const truncated = reports.some((r) => r.report?.truncated);
  const listErrors = reports.flatMap((r) => (r.report?.errors ?? []).map((e) => `${r.ctx}: ${e}`));

  if (selected.length === 0) {
    return <EmptyState icon={<HubOutlinedIcon />} title="No cluster selected" subtitle="Pick one or more clusters from the switcher in the top bar." />;
  }
  if (isLoading) {
    return <EmptyState icon={<CircularProgress size={40} />} title="Auditing…" subtitle={`Running security checks across ${selected.join(', ')}`} />;
  }

  const toggleSeverity = (s: AuditSeverity) => {
    setSeverityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pt: 1.5, pb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6">Security Audit</Typography>
        <Typography variant="caption" color="text.secondary">
          {checksRun} checks · {totalScanned} resources · {selected.length} cluster{selected.length > 1 ? 's' : ''}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Re-run audit">
          <span>
            <IconButton size="small" disabled={isFetching} onClick={() => void queryClient.invalidateQueries({ queryKey: ['audit'] })}>
              {isFetching ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          onClick={() => downloadFile('kubus-audit.json', 'application/json', JSON.stringify(activeFindings, null, 2))}
        >
          JSON
        </Button>
        <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadFile('kubus-audit.sarif', 'application/json', toSarif(activeFindings))}>
          SARIF
        </Button>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        {SEVERITIES.map((s) => (
          <Chip
            key={s}
            label={`${s} ${severityCounts[s]}`}
            color={SEVERITY_COLOR[s]}
            variant={severityFilter.size === 0 || severityFilter.has(s) ? 'filled' : 'outlined'}
            onClick={() => toggleSeverity(s)}
            size="small"
            sx={{ textTransform: 'capitalize' }}
          />
        ))}
        <TextField
          placeholder="Filter findings…"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          sx={{ width: 240 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            },
          }}
        />
      </Stack>

      {failures.map((f) => (
        <Alert key={f.ctx} severity="error" sx={{ mt: 1 }}>
          {f.ctx}: {f.error}
        </Alert>
      ))}
      {listErrors.length > 0 && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Some resources could not be scanned: {listErrors.slice(0, 3).join(' · ')}
          {listErrors.length > 3 ? ` (+${listErrors.length - 3} more)` : ''}
        </Alert>
      )}
      {truncated && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          The report was truncated — narrow it down by dismissing noisy checks or fixing the top findings first.
        </Alert>
      )}

      {groups.length === 0 ? (
        <EmptyState
          icon={<VerifiedUserOutlinedIcon color="success" />}
          title={allFindings.length ? 'No findings match the current filters' : 'No findings'}
          subtitle={allFindings.length ? 'Adjust the severity or text filters.' : 'All checks passed on the scanned resources.'}
        />
      ) : (
        <Box sx={{ mt: 1.5 }}>
          {groups.map((group) => (
            <Accordion key={group.checkId} disableGutters defaultExpanded={group.severity === 'critical'}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%', pr: 1 }}>
                  <Chip label={group.severity} color={SEVERITY_COLOR[group.severity]} size="small" sx={{ textTransform: 'capitalize', width: 72 }} />
                  <Typography sx={{ fontWeight: 600 }}>{group.title}</Typography>
                  <Chip label={group.findings.length} size="small" variant="outlined" />
                  <Chip label={group.category} size="small" variant="outlined" sx={{ color: 'text.secondary' }} />
                  <Box sx={{ flex: 1 }} />
                  <Tooltip title="Dismiss this check (hidden until restored)">
                    <IconButton
                      size="small"
                      aria-label={`Dismiss check ${group.checkId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissCheck(group.checkId);
                      }}
                    >
                      <VisibilityOffOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {group.remediation}
                </Typography>
                {group.findings.map((f, i) => (
                  <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', py: 0.25, flexWrap: 'wrap' }}>
                    {selected.length > 1 && <Chip label={f.resource.ctx} size="small" variant="outlined" />}
                    <Link
                      component="button"
                      variant="body2"
                      underline="hover"
                      sx={{ fontFamily: 'monospace' }}
                      onClick={() =>
                        openDetail({
                          ctx: f.resource.ctx,
                          group: f.resource.group,
                          version: f.resource.version,
                          plural: f.resource.plural,
                          kind: f.resource.kind,
                          name: f.resource.name,
                          namespace: f.resource.namespace,
                        })
                      }
                    >
                      {f.resource.kind}/{f.resource.namespace ? `${f.resource.namespace}/` : ''}
                      {f.resource.name}
                    </Link>
                    <Typography variant="body2" color="text.secondary">
                      {f.message}
                    </Typography>
                  </Box>
                ))}
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}

      {dismissedWithCounts.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
            Dismissed checks
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            {dismissedWithCounts.map(({ id, count }) => (
              <Chip key={id} label={`${id} (${count})`} size="small" onDelete={() => restoreCheck(id)} deleteIcon={<RefreshIcon />} />
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}
