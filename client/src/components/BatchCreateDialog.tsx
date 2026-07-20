import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { dump, load } from 'js-yaml';
import type { ResourceDryRunResponse } from '@kubus/shared';
import { useCreateResource, useDryRunResource, useResourceList } from '../api/queries.js';
import { cronHumanText, cronNextRuns } from '../cron.js';
import { showToast } from '../state/toast.js';
import { formatRelative } from './AgeCell.js';
import { YamlEditor } from './YamlEditor.js';

type BatchKind = 'Job' | 'CronJob';

const SCHEDULE_PRESETS = [
  { label: 'Every 5 min', expr: '*/5 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily', expr: '0 0 * * *' },
  { label: 'Weekly', expr: '0 0 * * 0' },
  { label: 'Monthly', expr: '0 0 1 * *' },
];

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function getIn(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur = root;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Immutable deep-set; a leaf value of `undefined` deletes the key instead. */
function setIn<T>(root: T, path: ReadonlyArray<string | number>, value: unknown): T {
  if (!path.length) return value as T;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  const container = (root ?? (typeof head === 'number' ? [] : {})) as Record<string | number, unknown>;
  const child = setIn(container[head], rest, value);
  if (Array.isArray(container)) {
    const copy = [...container];
    copy[head as number] = child;
    return copy as T;
  }
  const copy: Record<string | number, unknown> = { ...container };
  if (child === undefined) delete copy[head];
  else copy[head] = child;
  return copy as T;
}

function initialManifest(kind: BatchKind, namespace: string): Record<string, unknown> {
  const podTemplate = (restartPolicy: string) => ({
    spec: { restartPolicy, containers: [{ name: 'main', image: '' }] },
  });
  if (kind === 'CronJob') {
    return {
      apiVersion: 'batch/v1',
      kind,
      metadata: { name: '', namespace },
      spec: {
        schedule: '0 * * * *',
        concurrencyPolicy: 'Forbid',
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 1,
        jobTemplate: { spec: { backoffLimit: 3, template: podTemplate('OnFailure') } },
      },
    };
  }
  return {
    apiVersion: 'batch/v1',
    kind,
    metadata: { name: '', namespace },
    spec: { backoffLimit: 3, template: podTemplate('Never') },
  };
}

function toYaml(manifest: Record<string, unknown>): string {
  return dump(manifest, { noRefs: true, lineWidth: 120 });
}

/**
 * Guided create for Jobs and CronJobs: a form for the fields people actually
 * set (with live schedule feedback), and a YAML tab that round-trips with the
 * form — the form only overwrites the fields it owns, so YAML-only edits
 * (extra containers, volumes, env) survive switching back and forth.
 */
export function BatchCreateDialog({
  ctx,
  kind,
  group,
  version,
  defaultNamespace,
  onClose,
}: {
  ctx: string;
  kind: BatchKind;
  group: string;
  version: string;
  defaultNamespace?: string;
  onClose: () => void;
}) {
  const create = useCreateResource();
  const dryRun = useDryRunResource();
  const [manifest, setManifest] = useState(() => initialManifest(kind, defaultNamespace || 'default'));
  const [tab, setTab] = useState<'form' | 'yaml'>('form');
  // Seed for the YAML tab (frozen at switch time) and the live edited text.
  const [yamlSeed, setYamlSeed] = useState('');
  const [yamlText, setYamlText] = useState('');
  const [yamlBlocked, setYamlBlocked] = useState<string>();
  const [error, setError] = useState<string>();
  const [dryRunResult, setDryRunResult] = useState<ResourceDryRunResponse>();

  const namespaces = useResourceList({ ctx, group: '', version: 'v1', plural: 'namespaces' });
  const namespaceOptions = (namespaces.data?.items ?? []).map((ns) => ns.metadata.name);

  const jobSpecPath = kind === 'CronJob' ? ['spec', 'jobTemplate', 'spec'] : ['spec'];
  const podSpecPath = [...jobSpecPath, 'template', 'spec'];
  const containerPath = [...podSpecPath, 'containers', 0];

  const set = (path: ReadonlyArray<string | number>, value: unknown) => {
    setError(undefined);
    setDryRunResult(undefined);
    setManifest((m) => setIn(m, path, value));
  };

  const str = (path: ReadonlyArray<string | number>): string => {
    const v = getIn(manifest, path);
    return typeof v === 'string' ? v : '';
  };
  const num = (path: ReadonlyArray<string | number>): number | undefined => {
    const v = getIn(manifest, path);
    return typeof v === 'number' ? v : undefined;
  };

  const name = str(['metadata', 'name']);
  const namespace = str(['metadata', 'namespace']);
  const image = str([...containerPath, 'image']);
  const schedule = str(['spec', 'schedule']);
  const timeZone = str(['spec', 'timeZone']);
  const suspend = getIn(manifest, ['spec', 'suspend']) === true;

  const command = getIn(manifest, [...containerPath, 'command']);
  const commandDisplay = Array.isArray(command)
    ? command.length === 3 && command[0] === 'sh' && command[1] === '-c'
      ? String(command[2])
      : command.join(' ')
    : '';

  // CronJob names get a ~11-char timestamp suffix on each spawned Job, so keep them shorter.
  const maxName = kind === 'CronJob' ? 52 : 63;
  const nameInvalid = !!name && !(NAME_RE.test(name) && name.length <= maxName);

  const scheduleHuman = schedule ? cronHumanText(schedule) : undefined;
  const nextRuns = schedule ? cronNextRuns(schedule, timeZone || undefined, 3) : [];
  const scheduleInvalid = !!schedule && !scheduleHuman && nextRuns.length === 0;

  const formReady =
    !!name && !nameInvalid && !!image.trim() && (kind !== 'CronJob' || (!!schedule && !scheduleInvalid));

  const openYamlTab = () => {
    const text = toYaml(manifest);
    setYamlSeed(text);
    setYamlText(text);
    setYamlBlocked(undefined);
    setTab('yaml');
  };

  const backToForm = () => {
    try {
      const parsed = load(yamlText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a YAML mapping');
      setManifest(parsed as Record<string, unknown>);
      setYamlBlocked(undefined);
      setTab('form');
    } catch (err) {
      setYamlBlocked(`Fix the YAML before returning to the form: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const created = (obj: { metadata: { name: string } }) => {
    showToast('success', `Created ${kind} ${obj.metadata.name}`);
    onClose();
  };

  const submit = () => {
    setError(undefined);
    create.mutate(
      { ctx, yamlBody: toYaml(manifest) },
      { onSuccess: created, onError: (e) => setError(e instanceof Error ? e.message : String(e)) },
    );
  };

  const validate = () => {
    setError(undefined);
    dryRun.mutate(
      { ctx, yamlBody: toYaml(manifest) },
      { onSuccess: setDryRunResult, onError: (e) => setError(e instanceof Error ? e.message : String(e)) },
    );
  };

  const numberField = (label: string, path: ReadonlyArray<string | number>) => (
    <TextField
      key={label}
      size="small"
      type="number"
      label={label}
      value={num(path) ?? ''}
      onChange={(e) => set(path, e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
      slotProps={{ htmlInput: { min: 0 } }}
      sx={{ width: 190 }}
    />
  );

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: '85vh' } } }}>
      <DialogTitle sx={{ pb: 0 }}>
        Create {kind} on {ctx}
      </DialogTitle>
      <Tabs
        value={tab}
        onChange={(_e, v: 'form' | 'yaml') => (v === 'yaml' ? openYamlTab() : backToForm())}
        sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label="Form" value="form" />
        <Tab label="YAML" value="yaml" />
      </Tabs>
      {tab === 'form' && (
        <>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: '20px !important' }}>
            <Stack direction="row" spacing={2}>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Name"
                value={name}
                error={nameInvalid}
                helperText={nameInvalid ? `Lowercase DNS name, at most ${maxName} characters` : undefined}
                onChange={(e) => set(['metadata', 'name'], e.target.value)}
              />
              <Autocomplete
                freeSolo
                disableClearable
                size="small"
                options={namespaceOptions}
                value={namespace}
                onInputChange={(_e, v) => set(['metadata', 'namespace'], v)}
                sx={{ minWidth: 220 }}
                renderInput={(params) => <TextField {...params} label="Namespace" />}
              />
            </Stack>

            {kind === 'CronJob' && (
              <Box>
                <Stack direction="row" spacing={2}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Schedule"
                    value={schedule}
                    error={scheduleInvalid}
                    helperText={scheduleInvalid ? 'Unrecognized cron expression' : undefined}
                    onChange={(e) => set(['spec', 'schedule'], e.target.value)}
                  />
                  <Autocomplete
                    freeSolo
                    size="small"
                    options={TIMEZONES}
                    value={timeZone || null}
                    onInputChange={(_e, v) => set(['spec', 'timeZone'], v || undefined)}
                    sx={{ minWidth: 220 }}
                    renderInput={(params) => <TextField {...params} label="Time zone (optional)" />}
                  />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
                  {SCHEDULE_PRESETS.map((p) => (
                    <Chip
                      key={p.expr}
                      label={p.label}
                      size="small"
                      variant={schedule === p.expr ? 'filled' : 'outlined'}
                      onClick={() => set(['spec', 'schedule'], p.expr)}
                    />
                  ))}
                </Stack>
                {scheduleHuman && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {scheduleHuman}
                    {timeZone ? ` (${timeZone})` : ' (UTC)'}
                  </Typography>
                )}
                {nextRuns.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Next runs: {nextRuns.map((d) => formatRelative(d.toISOString())).join(' · ')} — first at{' '}
                    {nextRuns[0]?.toLocaleString()}
                  </Typography>
                )}
              </Box>
            )}

            <Stack direction="row" spacing={2}>
              <TextField
                fullWidth
                size="small"
                label="Image"
                placeholder="busybox:1.36"
                value={image}
                onChange={(e) => set([...containerPath, 'image'], e.target.value)}
              />
              <FormControl size="small" sx={{ minWidth: 160 }}>
                <InputLabel id="batch-restart">Restart policy</InputLabel>
                <Select
                  labelId="batch-restart"
                  label="Restart policy"
                  value={str([...podSpecPath, 'restartPolicy']) || 'Never'}
                  onChange={(e) => set([...podSpecPath, 'restartPolicy'], e.target.value)}
                >
                  <MenuItem value="Never">Never</MenuItem>
                  <MenuItem value="OnFailure">OnFailure</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <TextField
              fullWidth
              size="small"
              label="Command (optional)"
              helperText="Runs via sh -c; leave empty to use the image's entrypoint"
              value={commandDisplay}
              onChange={(e) => set([...containerPath, 'command'], e.target.value ? ['sh', '-c', e.target.value] : undefined)}
            />

            <Accordion disableGutters elevation={0} sx={{ border: 1, borderColor: 'divider', '&::before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="body2">Advanced</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                {kind === 'CronJob' && (
                  <FormControl size="small" sx={{ width: 190 }}>
                    <InputLabel id="batch-concurrency">Concurrency</InputLabel>
                    <Select
                      labelId="batch-concurrency"
                      label="Concurrency"
                      value={str(['spec', 'concurrencyPolicy']) || 'Allow'}
                      onChange={(e) => set(['spec', 'concurrencyPolicy'], e.target.value)}
                    >
                      <MenuItem value="Allow">Allow</MenuItem>
                      <MenuItem value="Forbid">Forbid</MenuItem>
                      <MenuItem value="Replace">Replace</MenuItem>
                    </Select>
                  </FormControl>
                )}
                {numberField('Backoff limit', [...jobSpecPath, 'backoffLimit'])}
                {kind === 'Job' && numberField('Completions', [...jobSpecPath, 'completions'])}
                {kind === 'Job' && numberField('Parallelism', [...jobSpecPath, 'parallelism'])}
                {numberField('Active deadline (s)', [...jobSpecPath, 'activeDeadlineSeconds'])}
                {numberField('TTL after finished (s)', [...jobSpecPath, 'ttlSecondsAfterFinished'])}
                {kind === 'CronJob' && numberField('Keep successful Jobs', ['spec', 'successfulJobsHistoryLimit'])}
                {kind === 'CronJob' && numberField('Keep failed Jobs', ['spec', 'failedJobsHistoryLimit'])}
                {kind === 'CronJob' && numberField('Starting deadline (s)', ['spec', 'startingDeadlineSeconds'])}
                {kind === 'CronJob' && (
                  <FormControlLabel
                    control={<Switch checked={suspend} onChange={(e) => set(['spec', 'suspend'], e.target.checked || undefined)} />}
                    label={<Typography variant="body2">Start suspended</Typography>}
                  />
                )}
              </AccordionDetails>
            </Accordion>

            {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}
            {dryRunResult?.findings.map((finding, i) => (
              <Alert key={`${finding.field ?? ''}:${i}`} severity={finding.severity === 'error' ? 'error' : finding.severity}>
                {finding.field ? `${finding.field}: ` : ''}
                {finding.message}
              </Alert>
            ))}
            {dryRunResult?.ok && dryRunResult.findings.length === 0 && (
              <Alert severity="success">Server dry-run accepted this {kind}.</Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button disabled={!formReady || dryRun.isPending || create.isPending} onClick={validate}>
              {dryRun.isPending ? 'Validating…' : dryRunResult?.ok ? 'Validated' : 'Dry run'}
            </Button>
            <Button variant="contained" disabled={!formReady || create.isPending} onClick={submit}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </>
      )}
      {tab === 'yaml' && (
        <>
          {yamlBlocked && (
            <Alert severity="error" sx={{ borderRadius: 0 }} onClose={() => setYamlBlocked(undefined)}>
              {yamlBlocked}
            </Alert>
          )}
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <YamlEditor
              value={yamlSeed}
              applyLabel="Create"
              applyUnchanged
              onChange={setYamlText}
              schema={{ ctx, group, version, kind }}
              onDryRun={(text) => dryRun.mutateAsync({ ctx, yamlBody: text })}
              onApply={async (text) => {
                const obj = await create.mutateAsync({ ctx, yamlBody: text });
                created(obj);
              }}
            />
          </Box>
        </>
      )}
    </Dialog>
  );
}
