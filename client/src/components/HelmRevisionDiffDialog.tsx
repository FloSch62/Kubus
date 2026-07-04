import { useMemo, useState } from 'react';
import { Alert, Box, Dialog, DialogContent, DialogTitle, MenuItem, Select, Stack, Tab, Tabs, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { dump as dumpYaml } from 'js-yaml';
import type { HelmReleaseDetail, HelmRevision } from '@kubus/shared';
import { useHelmRevision } from '../api/queries.js';
import { DiffViewer } from './DiffViewer.js';

type DiffTab = 'values' | 'computed' | 'manifest';

function textFor(detail: HelmReleaseDetail | undefined, tab: DiffTab): string {
  if (!detail) return '';
  if (tab === 'manifest') return detail.manifest;
  const values = tab === 'values' ? detail.values : detail.computedValues;
  return dumpYaml(values ?? {}, { noRefs: true });
}

interface Props {
  ctx: string;
  ns: string;
  name: string;
  revisions: HelmRevision[];
  /** Initial pair; the user can re-pick either side. */
  from: number;
  to: number;
  onClose: () => void;
}

/** Side-by-side diff of any two revisions of a Helm release. */
export function HelmRevisionDiffDialog({ ctx, ns, name, revisions, from: initialFrom, to: initialTo, onClose }: Props) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [tab, setTab] = useState<DiffTab>('values');

  const fromQuery = useHelmRevision(ctx, ns, name, from);
  const toQuery = useHelmRevision(ctx, ns, name, to);
  const error = fromQuery.error ?? toQuery.error;
  const loading = fromQuery.isLoading || toQuery.isLoading;

  const left = useMemo(() => textFor(fromQuery.data, tab), [fromQuery.data, tab]);
  const right = useMemo(() => textFor(toQuery.data, tab), [toQuery.data, tab]);
  const sorted = useMemo(() => [...revisions].sort((a, b) => a.revision - b.revision), [revisions]);

  const revisionSelect = (value: number, onChange: (rev: number) => void, label: string) => (
    <Select size="small" value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} sx={{ width: 150 }}>
      {sorted.map((r) => (
        <MenuItem key={r.revision} value={r.revision}>
          rev {r.revision} · {r.chartVersion}
        </MenuItem>
      ))}
    </Select>
  );

  return (
    <Dialog open onClose={onClose} maxWidth="xl" fullWidth slotProps={{ paper: { sx: { height: '85vh' } } }}>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6">{name}</Typography>
          {revisionSelect(from, setFrom, 'Diff from revision')}
          <ArrowForwardIcon fontSize="small" />
          {revisionSelect(to, setTo, 'Diff to revision')}
          <Box sx={{ flex: 1 }} />
          <Tabs value={tab} onChange={(_e, v) => setTab(v as DiffTab)} sx={{ minHeight: 32 }}>
            <Tab value="values" label="Values" sx={{ minHeight: 32, py: 0 }} />
            <Tab value="computed" label="Computed" sx={{ minHeight: 32, py: 0 }} />
            <Tab value="manifest" label="Manifest" sx={{ minHeight: 32, py: 0 }} />
          </Tabs>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1 }}>
        {error && <Alert severity="error">{error.message}</Alert>}
        {loading && <Typography color="text.secondary">Loading revisions…</Typography>}
        {!loading && !error && left === right && (
          <Alert severity="info" sx={{ mb: 1 }}>
            No {tab === 'manifest' ? 'manifest' : 'values'} changes between rev {from} and rev {to}.
          </Alert>
        )}
        {!loading && !error && (
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <DiffViewer left={left} right={right} />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
