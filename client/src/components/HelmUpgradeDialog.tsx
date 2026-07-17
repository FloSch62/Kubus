import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import Editor from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import { dump as dumpYaml } from 'js-yaml';
import type { HelmChartSourceRef, HelmDryRunResult, HelmReleaseDetail } from '@kubus/shared';
import { useHelmChartFind, useHelmUpgrade, useHelmUpgradeDryRun } from '../api/queries.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DiffViewer } from './DiffViewer.js';
import { HelmAddRepoDialog } from './HelmAddRepoDialog.js';
import { parseValues } from './helm-values.js';

interface Props {
  ctx: string;
  ns: string;
  name: string;
  release: HelmReleaseDetail;
  isProtected: boolean;
  onClose: () => void;
}

/** Reuse the chart stored in the release record (values-only upgrade). */
const CURRENT_CHART = '__current__';

/**
 * Edit values and/or bump the chart version of an installed release, with a
 * server-rendered manifest diff preview before anything is applied.
 */
export default function HelmUpgradeDialog({ ctx, ns, name, release, isProtected, onClose }: Props) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const initialValues = useMemo(() => {
    const text = dumpYaml(release.values ?? {}, { noRefs: true });
    return text === '{}\n' ? '' : text;
  }, [release.values]);

  const [valuesText, setValuesText] = useState(initialValues);
  const [chartChoice, setChartChoice] = useState(CURRENT_CHART);
  const [customRef, setCustomRef] = useState('');
  const [customVersion, setCustomVersion] = useState('');
  const [skipHooks, setSkipHooks] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [preview, setPreview] = useState<HelmDryRunResult>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);

  const { data: hits, isLoading: findLoading } = useHelmChartFind(release.chart);
  const upgrade = useHelmUpgrade();
  const dryRun = useHelmUpgradeDryRun();

  // repo|version option list across configured repos and Artifact Hub discoveries.
  const versionOptions = useMemo(
    () =>
      (hits ?? []).flatMap((hit) =>
        hit.versions
          .filter((v) => !v.deprecated)
          .map((v) => ({
            key: `${hit.repo}|${v.version}`,
            repo: hit.repo,
            repoUrl: hit.repoUrl,
            fromHub: hit.fromHub,
            version: v.version,
            appVersion: v.appVersion,
          })),
      ),
    [hits],
  );

  const valuesOnlyBlocked = release.chartDependencies > 0;

  const chartRef = (): HelmChartSourceRef | undefined => {
    if (customRef.trim()) {
      const ref = customRef.trim();
      return ref.startsWith('oci://') ? { ociRef: ref, version: customVersion.trim() || undefined } : { url: ref };
    }
    if (chartChoice === CURRENT_CHART) return undefined;
    const opt = versionOptions.find((o) => o.key === chartChoice);
    if (!opt) return undefined;
    return opt.repoUrl
      ? { repoUrl: opt.repoUrl, chart: release.chart, version: opt.version }
      : { repo: opt.repo, chart: release.chart, version: opt.version };
  };

  const buildVars = () => {
    const { values, error } = parseValues(valuesText);
    if (error) {
      setFormError(error);
      return undefined;
    }
    if (chartChoice === CURRENT_CHART && !customRef.trim() && valuesOnlyBlocked) {
      setFormError(
        `This chart declares ${release.chartDependencies} dependencies, which the in-cluster release record does not preserve — pick a chart version from a repository (or add a repository that carries "${release.chart}").`,
      );
      return undefined;
    }
    setFormError(undefined);
    return { ctx, ns, name, values: values!, chart: chartRef(), skipHooks };
  };

  const runPreview = () => {
    const vars = buildVars();
    if (!vars) return;
    setPreview(undefined);
    dryRun.mutate(vars, {
      onSuccess: setPreview,
      onError: (e) => setFormError(e.message),
    });
  };

  const runUpgrade = () => {
    const vars = buildVars();
    if (!vars) return;
    setConfirmOpen(false);
    upgrade.mutate(vars, {
      onSuccess: (r) => {
        showToast(
          'success',
          `Upgraded ${name} to revision ${r.revision} (${r.applied.length} applied${r.pruned.length ? `, ${r.pruned.length} pruned` : ''}${r.hooksRan.length ? `, ${r.hooksRan.length} hooks` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''})`,
        );
        onClose();
      },
      onError: (e) => setFormError(e.message),
    });
  };

  const busy = upgrade.isPending || dryRun.isPending;

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: '88vh' } } }}>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6">Upgrade {name}</Typography>
          <Chip size="small" label={`${release.chart}-${release.chartVersion}`} variant="outlined" />
          <Chip size="small" label={`rev ${release.revision}`} variant="outlined" />
          <Chip size="small" label={`${ns} @ ${ctx}`} variant="outlined" />
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1, gap: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
          <TextField
            select
            size="small"
            label="Chart version"
            value={chartChoice}
            onChange={(e) => setChartChoice(e.target.value)}
            disabled={!!customRef.trim()}
            sx={{ minWidth: 260 }}
          >
            <MenuItem value={CURRENT_CHART} disabled={valuesOnlyBlocked}>
              Keep current chart ({release.chartVersion}){valuesOnlyBlocked ? ' — needs repo (has dependencies)' : ''}
            </MenuItem>
            {findLoading && (
              <MenuItem disabled value="__loading__">
                Searching repositories & Artifact Hub…
              </MenuItem>
            )}
            {versionOptions.map((o) => (
              <MenuItem key={o.key} value={o.key}>
                {o.version}
                {o.appVersion ? ` (app ${o.appVersion})` : ''} · {o.repo}
                {o.fromHub ? ' · Artifact Hub' : ''}
              </MenuItem>
            ))}
          </TextField>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setAddRepoOpen(true)} disabled={!!customRef.trim()}>
            Add repo
          </Button>
          <TextField
            size="small"
            label="Custom source (oci:// or .tgz URL)"
            value={customRef}
            onChange={(e) => setCustomRef(e.target.value)}
            sx={{ minWidth: 280, flex: 1 }}
          />
          {customRef.trim().startsWith('oci://') && (
            <TextField size="small" label="Version" value={customVersion} onChange={(e) => setCustomVersion(e.target.value)} sx={{ width: 120 }} />
          )}
          <FormControlLabel
            control={<Checkbox size="small" checked={skipHooks} onChange={(e) => setSkipHooks(e.target.checked)} />}
            label="Skip hooks"
          />
        </Stack>
        {!findLoading && versionOptions.length === 0 && !customRef.trim() && (
          <Alert
            severity="info"
            sx={{ py: 0 }}
            action={
              <Button color="inherit" size="small" startIcon={<AddIcon />} onClick={() => setAddRepoOpen(true)}>
                Add repository
              </Button>
            }
          >
            “{release.chart}” was not found in your repositories or on Artifact Hub — add its repository to pick another chart version, or paste an oci:// / .tgz source above.
          </Alert>
        )}
        {formError && (
          <Alert severity="error" onClose={() => setFormError(undefined)}>
            {formError}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary">
          User-supplied values for the new revision (chart defaults apply underneath, like helm -f):
        </Typography>
        <Box sx={{ flex: 1, minHeight: 0, border: 1, borderColor: 'divider' }}>
          <Editor
            language="yaml"
            value={valuesText}
            onChange={(v) => setValuesText(v ?? '')}
            theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
            options={{ minimap: { enabled: false }, fontSize: monoFontSize, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, fixedOverflowWidgets: true }}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={runPreview} disabled={busy}>
          {dryRun.isPending ? 'Rendering…' : 'Preview changes'}
        </Button>
        <Button variant="contained" disabled={busy} onClick={() => (isProtected ? setConfirmOpen(true) : runUpgrade())}>
          {upgrade.isPending ? 'Upgrading…' : 'Upgrade'}
        </Button>
      </DialogActions>
      {preview && (
        <Dialog open onClose={() => setPreview(undefined)} maxWidth="xl" fullWidth slotProps={{ paper: { sx: { height: '85vh' } } }}>
          <DialogTitle sx={{ pb: 0.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="h6">Preview: rev {release.revision} → new manifest</Typography>
              <Chip size="small" label={`${preview.chart}-${preview.chartVersion}`} variant="outlined" />
              {preview.hooks.length > 0 && <Chip size="small" label={`${preview.hooks.length} hooks`} variant="outlined" />}
            </Stack>
          </DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1 }}>
            {preview.manifest === release.manifest && (
              <Alert severity="info" sx={{ mb: 1 }}>
                The rendered manifest is identical to the current revision.
              </Alert>
            )}
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <DiffViewer left={release.manifest} right={preview.manifest} />
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPreview(undefined)}>Back</Button>
            <Button variant="contained" disabled={busy} onClick={() => (isProtected ? setConfirmOpen(true) : runUpgrade())}>
              Upgrade
            </Button>
          </DialogActions>
        </Dialog>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`Upgrade ${name}`}
        confirmLabel="Upgrade"
        busy={upgrade.isPending}
        confirmText={name}
        message={
          <>
            Upgrade <b>{ns}/{name}</b> on protected cluster <b>{ctx}</b>?
          </>
        }
        onClose={() => setConfirmOpen(false)}
        onConfirm={runUpgrade}
      />
      {addRepoOpen && (
        <HelmAddRepoDialog defaultName={release.chart} onClose={() => setAddRepoOpen(false)} onAdded={() => setAddRepoOpen(false)} />
      )}
    </Dialog>
  );
}
