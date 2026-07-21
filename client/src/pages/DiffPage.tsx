import { useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DifferenceOutlinedIcon from '@mui/icons-material/DifferenceOutlined';
import { useQuery } from '@tanstack/react-query';
import { dump as dumpYaml } from 'js-yaml';
import { groupToPath, type KubeObject, type ListResponse, type ResourceKindInfo } from '@kubus/shared';
import { apiFetch } from '../api/http.js';
import { resourceUrl, useApiResources, useContexts, useNamespaces } from '../api/queries.js';
import { DiffViewer } from '../components/DiffViewer.js';
import { PageHeader } from '../components/PageHeader.js';
import { normalizeForDiff } from '../kube-display.js';

interface Side {
  ctx?: string;
  kind?: ResourceKindInfo;
  namespace?: string;
  name?: string;
}

function useSideObject(side: Side) {
  return useQuery({
    queryKey: ['diff-object', side],
    queryFn: () => apiFetch<KubeObject>(resourceUrl(side.ctx!, side.kind!.group, side.kind!.version, side.kind!.plural, side.name!, side.kind!.namespaced ? side.namespace : undefined)),
    enabled: !!side.ctx && !!side.kind && !!side.name && (!side.kind.namespaced || !!side.namespace),
  });
}

function toYaml(obj: KubeObject | undefined, normalize: boolean): string {
  if (!obj) return '';
  return dumpYaml(normalize ? normalizeForDiff(obj) : obj, { noRefs: true, sortKeys: true, lineWidth: 120 });
}

function useNames(side: Side) {
  return useQuery({
    queryKey: ['diff-names', side.ctx, side.kind, side.namespace],
    queryFn: async () => {
      const params = side.kind!.namespaced && side.namespace ? `?namespace=${encodeURIComponent(side.namespace)}` : '';
      const list = await apiFetch<ListResponse>(`/api/contexts/${encodeURIComponent(side.ctx!)}/resources/${groupToPath(side.kind!.group)}/${side.kind!.version}/${side.kind!.plural}${params}`);
      return list.items.map((i) => i.metadata.name).sort();
    },
    enabled: !!side.ctx && !!side.kind && (!side.kind.namespaced || !!side.namespace),
  });
}

export function DiffPage() {
  const [left, setLeft] = useState<Side>({});
  const [right, setRight] = useState<Side>({});
  const [normalize, setNormalize] = useState(true);

  const leftObj = useSideObject(left);
  const rightObj = useSideObject(right);

  const leftText = useMemo(() => toYaml(leftObj.data, normalize), [leftObj.data, normalize]);
  const rightText = useMemo(() => toYaml(rightObj.data, normalize), [rightObj.data, normalize]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, p: 1.5 }}>
      <PageHeader title="Resource Diff" icon={<DifferenceOutlinedIcon />}>
        <Box sx={{ flex: 1 }} />
        <FormControlLabel
          control={<Switch size="small" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />}
          label={<Typography variant="body2">Ignore status & server-set metadata</Typography>}
        />
      </PageHeader>
      <Grid container spacing={2} sx={{ mb: 1 }}>
        <Grid size={6}>
          <SidePicker label="Left" side={left} onChange={setLeft} />
        </Grid>
        <Grid size={6}>
          <SidePicker label="Right" side={right} onChange={setRight} />
        </Grid>
      </Grid>
      <Box sx={{ flex: 1, minHeight: 0, border: 1, borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden' }}>
        {leftText && rightText ? (
          <DiffViewer left={leftText} right={rightText} />
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Typography color="text.secondary">Pick a resource on each side to compare — e.g. the same ConfigMap in two clusters.</Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function SidePicker({ label, side, onChange }: { label: string; side: Side; onChange: (s: Side) => void }) {
  const { data: contexts } = useContexts({ poll: false });
  const activeContexts = (contexts ?? []).filter((c) => c.active).map((c) => c.name);
  const { data: kinds } = useApiResources(side.ctx);
  const { data: namespaces } = useNamespaces(side.ctx ? [side.ctx] : []);
  const { data: names } = useNames(side);

  const listableKinds = useMemo(() => (kinds ?? []).filter((k) => k.verbs.includes('get')).sort((a, b) => a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group)), [kinds]);

  return (
    // Flexible widths + wrapping: once the namespace picker appears, four
    // fixed-width controls per side would ellipsize every selected value.
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Autocomplete
        size="small"
        sx={{ flex: '1 1 150px', minWidth: 150 }}
        options={activeContexts}
        value={side.ctx ?? null}
        onChange={(_e, ctx) => onChange({ ctx: ctx ?? undefined })}
        renderInput={(p) => <TextField {...p} label={`${label} cluster`} />}
      />
      <Autocomplete
        size="small"
        sx={{ flex: '1 1 170px', minWidth: 170 }}
        options={listableKinds}
        getOptionLabel={(k) => (k.group ? `${k.kind} (${k.group})` : k.kind)}
        value={side.kind ?? null}
        isOptionEqualToValue={(a, b) => a.group === b.group && a.version === b.version && a.plural === b.plural}
        onChange={(_e, kind) => onChange({ ctx: side.ctx, kind: kind ?? undefined })}
        renderInput={(p) => <TextField {...p} label="Kind" />}
        disabled={!side.ctx}
      />
      {side.kind?.namespaced && (
        <Autocomplete
          size="small"
          sx={{ flex: '1 1 150px', minWidth: 150 }}
          options={namespaces ?? []}
          value={side.namespace ?? null}
          onChange={(_e, namespace) => onChange({ ...side, namespace: namespace ?? undefined, name: undefined })}
          renderInput={(p) => <TextField {...p} label="Namespace" />}
        />
      )}
      <Autocomplete
        size="small"
        sx={{ flex: '2 1 180px', minWidth: 180 }}
        options={names ?? []}
        value={side.name ?? null}
        onChange={(_e, name) => onChange({ ...side, name: name ?? undefined })}
        renderInput={(p) => <TextField {...p} label="Name" />}
        disabled={!side.kind || (side.kind.namespaced && !side.namespace)}
      />
    </Stack>
  );
}
