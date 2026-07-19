import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
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
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import Editor from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import { dump as dumpYaml } from 'js-yaml';
import type { HelmChartSourceRef, HelmDryRunResult, HelmReleaseDetail } from '@kubus/shared';
import { useHelmChartFind, useHelmChartSourceDetail, useHelmUpgrade, useHelmUpgradeDryRun } from '../api/queries.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DiffViewer } from './DiffViewer.js';
import { HelmAddRepoDialog } from './HelmAddRepoDialog.js';
import { canonicalValuesYaml, parseValues, unknownValuePaths } from './helm-values.js';
import { compareHelmVersions } from './helm-version.js';
import { ChartMarkdown } from './ChartMarkdown.js';
import { ChartSourceLink, preferredChartSource } from './ChartSourceLink.js';
import { HelmOperationErrorAlert } from './HelmOperationErrorAlert.js';

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

function DefaultValuesDiff({
  left,
  right,
  installedVersion,
  targetVersion,
}: {
  left: string;
  right: string;
  installedVersion: string;
  targetVersion: string;
}) {
  const unchanged = left === right;
  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
        <Typography variant="caption" sx={{ width: '50%', px: 1.5, py: 0.5, fontWeight: 600 }}>
          {installedVersion} · installed
        </Typography>
        <Typography variant="caption" sx={{ width: '50%', px: 1.5, py: 0.5, borderLeft: 1, borderColor: 'divider', fontWeight: 600 }}>
          {targetVersion} · selected
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {unchanged ? (
          <Alert severity="info" sx={{ m: 1.5 }}>
            The chart’s default values are identical in these versions.
          </Alert>
        ) : (
          <DiffViewer left={left} right={right} />
        )}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        Comments, formatting, and key order are normalized so this diff shows value changes only.
      </Typography>
    </Box>
  );
}

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
  const [choiceTouched, setChoiceTouched] = useState(false);
  const [customRef, setCustomRef] = useState('');
  const [customVersion, setCustomVersion] = useState('');
  const [skipHooks, setSkipHooks] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [operationError, setOperationError] = useState<Error>();
  const [preview, setPreview] = useState<HelmDryRunResult>();
  const [editTab, setEditTab] = useState<'values' | 'defaults' | 'readme'>('values');
  const [previewTab, setPreviewTab] = useState<'values' | 'computed' | 'manifest' | 'defaults'>('manifest');
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
            key: `${hit.repoUrl ?? hit.repo}|${v.version}`,
            repo: hit.repo,
            repoUrl: hit.repoUrl,
            fromHub: hit.fromHub,
            version: v.version,
            appVersion: v.appVersion,
            sourceHasCurrent: hit.versions.some(
              (candidate) =>
                candidate.version === release.chartVersion &&
                (!release.appVersion || !candidate.appVersion || candidate.appVersion === release.appVersion),
            ),
          })),
      ).toSorted((a, b) => compareHelmVersions(b.version, a.version)),
    [hits, release.appVersion, release.chartVersion],
  );

  const valuesOnlyBlocked = release.chartDependencies > 0;
  const recommended = versionOptions.find((option) => option.sourceHasCurrent && compareHelmVersions(option.version, release.chartVersion) > 0);

  useEffect(() => {
    if (!choiceTouched && recommended) setChartChoice(recommended.key);
  }, [choiceTouched, recommended]);

  const selectedOption = versionOptions.find((option) => option.key === chartChoice);
  const selectedSource = useMemo<HelmChartSourceRef | undefined>(() => {
    if (customRef.trim()) {
      const ref = customRef.trim();
      // Partial input must not become a fetchable source.
      if (!/^(?:https?|oci):\/\/\S+$/.test(ref)) return undefined;
      if (ref.startsWith('oci://')) return customVersion.trim() ? { ociRef: ref, version: customVersion.trim() } : undefined;
      return { url: ref };
    }
    if (!selectedOption) return undefined;
    return selectedOption.repoUrl
      ? { repoUrl: selectedOption.repoUrl, chart: release.chart, version: selectedOption.version }
      : { repo: selectedOption.repo, chart: release.chart, version: selectedOption.version };
  }, [customRef, customVersion, release.chart, selectedOption]);
  // Debounce the detail lookup for hand-typed custom sources: every fetch is a
  // server-side chart download, which must not run per keystroke. Repo/hub
  // options are discrete clicks and resolve immediately.
  const [detailSource, setDetailSource] = useState<HelmChartSourceRef | undefined>();
  useEffect(() => {
    if (!customRef.trim()) {
      setDetailSource(selectedSource);
      return;
    }
    const t = setTimeout(() => setDetailSource(selectedSource), 400);
    return () => clearTimeout(t);
  }, [customRef, selectedSource]);
  const targetDetail = useHelmChartSourceDetail(detailSource);
  // Detail data may still belong to the previously debounced source.
  const detailCurrent = JSON.stringify(detailSource) === JSON.stringify(selectedSource);
  const customTargetKnown = !customRef.trim() || (detailCurrent && !!targetDetail.data?.version);
  const targetVersion = (detailCurrent ? targetDetail.data?.version : undefined) ?? selectedOption?.version;
  const versionDelta = targetVersion ? compareHelmVersions(targetVersion, release.chartVersion) : 0;
  const isDowngrade = versionDelta < 0;
  const isVersionUpgrade = versionDelta > 0;
  const targetDefaultValues = targetDetail.data?.values ?? release.defaultValues;
  const targetDefaultsYaml = useMemo(() => canonicalValuesYaml(targetDefaultValues), [targetDefaultValues]);
  const currentDefaultsYaml = useMemo(() => canonicalValuesYaml(release.defaultValues), [release.defaultValues]);
  const possiblyRemovedValues = useMemo(
    () => (targetDetail.data ? unknownValuePaths(release.values, targetDetail.data.values) : []),
    [release.values, targetDetail.data],
  );
  const readmeSource = preferredChartSource(
    targetDetail.data?.sources?.length ? targetDetail.data.sources : release.chartSources,
    targetDetail.data?.home ?? release.chartHome,
  );

  const chartRef = (): HelmChartSourceRef | undefined => {
    if (customRef.trim()) return selectedSource;
    if (chartChoice === CURRENT_CHART) return undefined;
    return selectedSource;
  };

  const buildVars = () => {
    const { values, error } = parseValues(valuesText);
    if (error) {
      setFormError(error);
      return undefined;
    }
    if (customRef.trim().startsWith('oci://') && !customVersion.trim()) {
      setFormError('OCI chart sources need an explicit version.');
      return undefined;
    }
    if (customRef.trim() && !selectedSource) {
      setFormError('Custom chart source must be a complete oci:// ref or http(s) chart URL.');
      return undefined;
    }
    // The downgrade warning and typed confirmation hinge on knowing the target
    // version; applying an unresolved custom source would bypass both.
    if (customRef.trim() && !customTargetKnown) {
      setFormError(
        targetDetail.error
          ? `The custom chart source could not be loaded: ${targetDetail.error.message}`
          : 'Still resolving the custom chart source — wait for the target version to load.',
      );
      return undefined;
    }
    if (chartChoice === CURRENT_CHART && !customRef.trim() && valuesOnlyBlocked) {
      setFormError(
        `This chart declares ${release.chartDependencies} dependencies, which the in-cluster release record does not preserve — pick a chart version from a repository (or add a repository that carries "${release.chart}").`,
      );
      return undefined;
    }
    setFormError(undefined);
    setOperationError(undefined);
    return { ctx, ns, name, values: values!, chart: chartRef(), skipHooks };
  };

  const runPreview = () => {
    const vars = buildVars();
    if (!vars) return;
    setPreview(undefined);
    setOperationError(undefined);
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
      onSuccess: () => {
        onClose();
        showToast('info', `${actionLabel} started for ${ns}/${name}. Progress is shown on the release page.`);
      },
      onError: (e) => {
        setFormError(undefined);
        setOperationError(e);
      },
    });
  };

  const busy = upgrade.isPending || dryRun.isPending;
  const needsConfirmation = isProtected || isDowngrade;
  const actionLabel = isDowngrade ? 'Downgrade' : isVersionUpgrade ? 'Upgrade' : 'Apply changes';

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: '88vh' } } }}>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6">Upgrade {name}</Typography>
          <Chip size="small" label={`${release.chart}-${release.chartVersion}`} variant="outlined" />
          {targetVersion && targetVersion !== release.chartVersion ? (
            <Chip size="small" color={isDowngrade ? 'warning' : 'primary'} label={`→ ${targetVersion}`} />
          ) : null}
          <Chip size="small" label={`rev ${release.revision}`} variant="outlined" />
          <Chip size="small" label={`${ns} @ ${ctx}`} variant="outlined" />
          <ChartSourceLink url={readmeSource} />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Kubus checks workload readiness in the background. You can leave this dialog; live status and recovery guidance remain on the release page.
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1, gap: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
          <TextField
            select
            size="small"
            label="Chart version"
            value={chartChoice}
            onChange={(e) => {
              setChoiceTouched(true);
              setChartChoice(e.target.value);
            }}
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
                {compareHelmVersions(o.version, release.chartVersion) > 0
                  ? ' · update'
                  : compareHelmVersions(o.version, release.chartVersion) < 0
                    ? ' · downgrade'
                    : ' · current'}
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
        {operationError ? <HelmOperationErrorAlert error={operationError} onReview={onClose} /> : null}
        {targetDetail.error ? <Alert severity="error">Could not load the selected chart metadata: {targetDetail.error.message}</Alert> : null}
        {isDowngrade ? (
          <Alert severity="warning">
            <AlertTitle>This is a chart and application downgrade</AlertTitle>
            Back up persistent data and read the chart’s upgrade/recovery documentation first. Database schemas and data migrations are often not reversible; a
            Kubernetes rollback cannot undo them. Kubus will wait for workloads and record a failed revision if they do not recover.
          </Alert>
        ) : null}
        {possiblyRemovedValues.length ? (
          <Alert severity="warning">
            {possiblyRemovedValues.length} current override path(s) are not present in the selected chart defaults: {possiblyRemovedValues.slice(0, 8).join(', ')}
            {possiblyRemovedValues.length > 8 ? '…' : ''}. Check the README and default-values diff for renamed or removed settings.
          </Alert>
        ) : null}
        <Tabs value={editTab} onChange={(_event, value) => setEditTab(value as typeof editTab)} sx={{ minHeight: 32, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="values" label="Your values" sx={{ minHeight: 32, py: 0 }} />
          <Tab value="defaults" label="Default values diff" sx={{ minHeight: 32, py: 0 }} />
          {targetDetail.data?.readme ? <Tab value="readme" label="README" sx={{ minHeight: 32, py: 0 }} /> : null}
        </Tabs>
        {editTab === 'values' ? (
          <Typography variant="caption" color="text.secondary">
            User-supplied overrides for the new revision. The selected chart defaults apply underneath, like helm -f.
          </Typography>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0, border: 1, borderColor: 'divider' }}>
          {editTab === 'values' ? (
            <Editor
              language="yaml"
              value={valuesText}
              onChange={(v) => setValuesText(v ?? '')}
              theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
              options={{ minimap: { enabled: false }, fontSize: monoFontSize, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, fixedOverflowWidgets: true }}
            />
          ) : editTab === 'defaults' ? (
            targetDetail.isLoading ? (
              <Typography color="text.secondary" sx={{ p: 2 }}>
                Loading selected chart defaults…
              </Typography>
            ) : (
              <DefaultValuesDiff
                left={currentDefaultsYaml}
                right={targetDefaultsYaml}
                installedVersion={release.chartVersion}
                targetVersion={targetVersion ?? release.chartVersion}
              />
            )
          ) : (
            <ChartMarkdown markdown={targetDetail.data?.readme ?? ''} sourceUrl={readmeSource} />
          )}
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
        <Button
          variant="contained"
          color={isDowngrade ? 'warning' : 'primary'}
          disabled={busy || !customTargetKnown}
          onClick={() => (needsConfirmation ? setConfirmOpen(true) : runUpgrade())}
        >
          {upgrade.isPending ? 'Starting…' : !customTargetKnown ? 'Resolving chart…' : actionLabel}
        </Button>
      </DialogActions>
      {preview && (
        <Dialog open onClose={() => setPreview(undefined)} maxWidth="xl" fullWidth slotProps={{ paper: { sx: { height: '85vh' } } }}>
          <DialogTitle sx={{ pb: 0.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="h6">Preview: rev {release.revision} → {preview.chartVersion}</Typography>
              <Chip size="small" label={`${preview.chart}-${preview.chartVersion}`} variant="outlined" />
              {preview.hooks.length > 0 && <Chip size="small" label={`${preview.hooks.length} hooks`} variant="outlined" />}
              <Box sx={{ flex: 1 }} />
              <Tabs value={previewTab} onChange={(_event, value) => setPreviewTab(value as typeof previewTab)} sx={{ minHeight: 32 }}>
                <Tab value="values" label="Your values" sx={{ minHeight: 32, py: 0 }} />
                <Tab value="computed" label="Computed" sx={{ minHeight: 32, py: 0 }} />
                <Tab value="defaults" label="Defaults" sx={{ minHeight: 32, py: 0 }} />
                <Tab value="manifest" label="Manifest" sx={{ minHeight: 32, py: 0 }} />
              </Tabs>
            </Stack>
          </DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1 }}>
            {preview.warnings.map((warning) => (
              <Alert key={warning} severity="warning" sx={{ mb: 1 }}>
                {warning}
              </Alert>
            ))}
            {preview.validation.some((item) => item.status === 'error') ? (
              <Alert severity="error" sx={{ mb: 1 }}>
                Kubernetes rejected {preview.validation.filter((item) => item.status === 'error').length} candidate resource(s) in server-side dry-run:{' '}
                {preview.validation
                  .filter((item) => item.status === 'error')
                  .slice(0, 3)
                  .map((item) => `${item.resource}: ${item.message}`)
                  .join('; ')}
              </Alert>
            ) : (
              <Alert severity="success" sx={{ mb: 1 }}>
                Rendering and Kubernetes server-side dry-run passed for {preview.validation.filter((item) => item.status === 'valid').length} resources. Runtime hooks
                and application data migrations still run only during the real operation.
              </Alert>
            )}
            {previewTab === 'manifest' && preview.manifest === release.manifest && (
              <Alert severity="info" sx={{ mb: 1 }}>
                The rendered manifest is identical to the current revision.
              </Alert>
            )}
            <Box sx={{ flex: 1, minHeight: 0 }}>
              {previewTab === 'manifest' ? (
                <DiffViewer left={release.manifest} right={preview.manifest} />
              ) : previewTab === 'computed' ? (
                <DiffViewer
                  left={dumpYaml(release.computedValues, { noRefs: true })}
                  right={dumpYaml(preview.computedValues, { noRefs: true })}
                />
              ) : previewTab === 'defaults' ? (
                <DefaultValuesDiff
                  left={currentDefaultsYaml}
                  right={targetDefaultsYaml}
                  installedVersion={release.chartVersion}
                  targetVersion={preview.chartVersion}
                />
              ) : (
                <DiffViewer left={initialValues} right={dumpYaml(parseValues(valuesText).values ?? {}, { noRefs: true })} />
              )}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPreview(undefined)}>Back</Button>
            <Button
              variant="contained"
              color={isDowngrade ? 'warning' : 'primary'}
              disabled={busy || preview.validation.some((item) => item.status === 'error')}
              onClick={() => (needsConfirmation ? setConfirmOpen(true) : runUpgrade())}
            >
              {actionLabel}
            </Button>
          </DialogActions>
        </Dialog>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`${actionLabel} ${name}`}
        danger={isDowngrade}
        confirmLabel={actionLabel}
        busy={upgrade.isPending}
        confirmText={name}
        message={
          <>
            {isDowngrade ? (
              <>
                Downgrade <b>{ns}/{name}</b> from <b>{release.chartVersion}</b> to <b>{targetVersion}</b>? This can leave databases or persistent data incompatible
                even if Kubernetes resources roll back. Confirm that you have a backup and the application explicitly supports this path.
              </>
            ) : (
              <>
                {actionLabel} <b>{ns}/{name}</b>
                {isProtected ? (
                  <>
                    {' '}on protected cluster <b>{ctx}</b>
                  </>
                ) : null}
                ? Kubus will check workload readiness in the background.
              </>
            )}
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
