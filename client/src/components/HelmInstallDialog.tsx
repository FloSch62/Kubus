import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import SearchIcon from '@mui/icons-material/Search';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import Editor from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import { dump as dumpYaml } from 'js-yaml';
import type { HelmChartSourceRef, HelmChartSummary, HelmDryRunResult, HelmHubChart } from '@kubus/shared';
import {
  useHelmChartDetail,
  useHelmChartDetailByUrl,
  useHelmChartSourceDetail,
  useHelmChartVersions,
  useHelmHubSearch,
  useHelmHubVersions,
  useHelmInstall,
  useHelmInstallDryRun,
  useHelmOciDetail,
  useHelmRepoCharts,
  useHelmRepos,
  useNamespaces,
  useRemoveHelmRepo,
} from '../api/queries.js';
import { useIsProtected } from '../state/clusters.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { HelmAddRepoDialog } from './HelmAddRepoDialog.js';
import { parseValues, rebaseValuesText, valuesOverrides } from './helm-values.js';
import { showToast } from '../state/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ChartMarkdown } from './ChartMarkdown.js';
import { ChartSourceLink, preferredChartSource } from './ChartSourceLink.js';

interface Props {
  /** Candidate target clusters (the ones selected in the sidebar). */
  contexts: string[];
  onClose: () => void;
}

interface ChartPick {
  repo?: string;
  chart?: string;
  /** Artifact Hub discovery: hub repo name + its repository URL. */
  hubRepo?: string;
  repoUrl?: string;
  /** oci:// ref or direct .tgz URL. */
  customRef?: string;
}

/** Browse configured chart repositories and install a release. */
export default function HelmInstallDialog({ contexts, onClose }: Props) {
  const [pick, setPick] = useState<ChartPick>();

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: '88vh' } } }}>
      {pick ? <ConfigureStep contexts={contexts} pick={pick} onBack={() => setPick(undefined)} onClose={onClose} /> : <CatalogStep onPick={setPick} onClose={onClose} />}
    </Dialog>
  );
}

// ---- Step 1: catalog ----

/** Pseudo-source: search all of Artifact Hub instead of one configured repo. */
const HUB_SOURCE = '__hub__';

function CatalogStep({ onPick, onClose }: { onPick: (pick: ChartPick) => void; onClose: () => void }) {
  const { data: repos, isLoading: reposLoading } = useHelmRepos();
  const [selectedRepo, setSelectedRepo] = useState<string>();
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [customRef, setCustomRef] = useState('');

  const source = selectedRepo ?? HUB_SOURCE;
  const isHub = source === HUB_SOURCE;
  const { data: charts, isLoading: chartsLoading, error: chartsError } = useHelmRepoCharts(isHub ? undefined : source);

  // Debounce free-text hub searches; local repo filtering stays immediate.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);
  const hub = useHelmHubSearch(isHub ? debouncedQuery : '');

  const filtered = useMemo(() => {
    if (!charts) return [];
    const q = query.trim().toLowerCase();
    if (!q) return charts;
    return charts.filter((c) => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q) || c.keywords?.some((k) => k.toLowerCase().includes(q)));
  }, [charts, query]);

  return (
    <>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <SailingOutlinedIcon fontSize="small" />
          <Typography variant="h6">Install chart</Typography>
          <Box sx={{ flex: 1 }} />
          <TextField
            size="small"
            placeholder="oci://registry/repo or https://…/chart.tgz"
            value={customRef}
            onChange={(e) => setCustomRef(e.target.value)}
            sx={{ width: 320 }}
          />
          <Button disabled={!customRef.trim()} onClick={() => onPick({ customRef: customRef.trim() })}>
            Use ref
          </Button>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', minHeight: 0, gap: 1.5, pt: 1 }}>
        <Box sx={{ width: 230, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }}>
              Repositories
            </Typography>
            <Tooltip title="Add repository">
              <IconButton size="small" onClick={() => setAddOpen(true)}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          <List dense sx={{ flex: 1, overflowY: 'auto', pt: 0 }}>
            <ListItemButton selected={isHub} onClick={() => setSelectedRepo(undefined)} sx={{ pr: 1 }}>
              <TravelExploreIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
              <ListItemText primary="Artifact Hub" secondary="search all public charts" slotProps={{ secondary: { noWrap: true, sx: { fontSize: 11 } } }} />
            </ListItemButton>
            {(repos ?? []).map((r) => (
              <RepoRow key={r.name} name={r.name} url={r.url} selected={r.name === source} onSelect={() => setSelectedRepo(r.name)} />
            ))}
          </List>
          {!reposLoading && !repos?.length && (
            <Alert severity="info" sx={{ mt: 1 }}>
              No repositories configured — Artifact Hub search covers the public ecosystem; add a repository for private or unlisted charts.
            </Alert>
          )}
        </Box>
        <Divider orientation="vertical" flexItem />
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <TextField
            size="small"
            placeholder={isHub ? 'Search Artifact Hub (any public chart — try "harbor", "nginx", "cert-manager")' : 'Search charts'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
            sx={{ mb: 1 }}
          />
          {!isHub && chartsError && <Alert severity="error">{chartsError.message}</Alert>}
          {isHub && hub.error && <Alert severity="error">{hub.error.message}</Alert>}
          {(isHub ? hub.isFetching && !hub.data : chartsLoading) && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress size={24} />
            </Box>
          )}
          <List dense sx={{ flex: 1, overflowY: 'auto', pt: 0 }}>
            {isHub
              ? (hub.data ?? []).map((c) => (
                  <HubChartRow key={`${c.repoName}/${c.name}`} chart={c} onSelect={() => onPick({ chart: c.name, hubRepo: c.repoName, repoUrl: c.repoUrl })} />
                ))
              : filtered.map((c) => (
                  <ChartRow key={`${c.repo}/${c.name}`} chart={c} onSelect={() => onPick({ repo: c.repo, chart: c.name })} />
                ))}
          </List>
          {isHub && debouncedQuery.length < 2 && !hub.data?.length && (
            <Typography color="text.secondary" sx={{ p: 2 }}>
              Type to search every public chart on Artifact Hub.
            </Typography>
          )}
          {isHub && debouncedQuery.length >= 2 && !hub.isFetching && !hub.data?.length && (
            <Typography color="text.secondary" sx={{ p: 2 }}>
              No charts found for “{debouncedQuery}”.
            </Typography>
          )}
          {!isHub && !chartsLoading && !filtered.length && (
            <Typography color="text.secondary" sx={{ p: 2 }}>
              No charts match.
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
      {addOpen && <HelmAddRepoDialog onClose={() => setAddOpen(false)} onAdded={setSelectedRepo} />}
    </>
  );
}

function HubChartRow({ chart, onSelect }: { chart: HelmHubChart; onSelect: () => void }) {
  return (
    <ListItemButton onClick={onSelect} sx={{ gap: 1.5 }}>
      <Avatar src={chart.icon} variant="rounded" sx={{ width: 34, height: 34, bgcolor: 'transparent' }}>
        <SailingOutlinedIcon fontSize="small" color="disabled" />
      </Avatar>
      <ListItemText
        primary={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <span>{chart.name}</span>
            <Chip size="small" label={chart.version} variant="outlined" sx={{ height: 18, fontSize: 11 }} />
            <Chip size="small" label={chart.repoName} variant="outlined" sx={{ height: 18, fontSize: 11 }} />
            {chart.official && <Chip size="small" color="success" label="official" sx={{ height: 18, fontSize: 11 }} />}
            {!chart.official && chart.verifiedPublisher && <Chip size="small" color="info" label="verified" sx={{ height: 18, fontSize: 11 }} />}
          </Stack>
        }
        secondary={chart.description}
        slotProps={{ secondary: { noWrap: true } }}
      />
    </ListItemButton>
  );
}

function RepoRow({ name, url, selected, onSelect }: { name: string; url: string; selected: boolean; onSelect: () => void }) {
  const removeRepo = useRemoveHelmRepo();
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <ListItemButton selected={selected} onClick={onSelect} sx={{ pr: 1 }}>
        <ListItemText primary={name} secondary={url} slotProps={{ secondary: { noWrap: true, sx: { fontSize: 11 } } }} />
        <IconButton
          size="small"
          edge="end"
          aria-label={`Remove repository ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(true);
          }}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </ListItemButton>
      <ConfirmDialog
        open={confirmOpen}
        title={`Remove repository ${name}`}
        danger
        confirmLabel="Remove"
        busy={removeRepo.isPending}
        message={<>Remove chart repository <b>{name}</b> from Kubus? Installed releases are not affected.</>}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          removeRepo.mutate(name, {
            onSuccess: () => setConfirmOpen(false),
            onError: (e) => {
              setConfirmOpen(false);
              showToast('error', e.message);
            },
          })
        }
      />
    </>
  );
}

function ChartRow({ chart, onSelect }: { chart: HelmChartSummary; onSelect: () => void }) {
  return (
    <ListItemButton onClick={onSelect} sx={{ gap: 1.5 }}>
      <Avatar src={chart.icon} variant="rounded" sx={{ width: 34, height: 34, bgcolor: 'transparent' }}>
        <SailingOutlinedIcon fontSize="small" color="disabled" />
      </Avatar>
      <ListItemText
        primary={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <span>{chart.name}</span>
            <Chip size="small" label={chart.version} variant="outlined" sx={{ height: 18, fontSize: 11 }} />
            {chart.appVersion && <Chip size="small" label={`app ${chart.appVersion}`} variant="outlined" sx={{ height: 18, fontSize: 11 }} />}
            {chart.deprecated && <Chip size="small" color="warning" label="deprecated" sx={{ height: 18, fontSize: 11 }} />}
          </Stack>
        }
        secondary={chart.description}
        slotProps={{ secondary: { noWrap: true } }}
      />
    </ListItemButton>
  );
}

// ---- Step 2: configure & install ----

function ConfigureStep({ contexts, pick, onBack, onClose }: { contexts: string[]; pick: ChartPick; onBack: () => void; onClose: () => void }) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);

  const isOci = !!pick.customRef?.startsWith('oci://');
  const isUrl = !!pick.customRef && !isOci;
  const isHub = !!pick.hubRepo;

  const { data: repoVersions } = useHelmChartVersions(pick.repo, pick.chart);
  const hubInfo = useHelmHubVersions(pick.hubRepo, isHub ? pick.chart : undefined);
  const versions = isHub ? hubInfo.data?.versions : repoVersions;
  const repoUrl = isHub ? (hubInfo.data?.repoUrl ?? pick.repoUrl) : undefined;
  const [version, setVersion] = useState<string>();
  const effectiveVersion = version ?? versions?.[0]?.version;
  const [ociVersion, setOciVersion] = useState('');
  // Debounced: each detail fetch for an OCI tag is a server-side registry pull,
  // which must not run per keystroke.
  const [debouncedOciVersion, setDebouncedOciVersion] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedOciVersion(ociVersion.trim()), 400);
    return () => clearTimeout(t);
  }, [ociVersion]);

  const repoDetail = useHelmChartDetail(pick.repo, pick.chart, effectiveVersion);
  const urlDetail = useHelmChartDetailByUrl(repoUrl, isHub ? pick.chart : undefined, isHub ? effectiveVersion : undefined);
  const ociDetail = useHelmOciDetail(isOci ? pick.customRef : undefined, isOci ? debouncedOciVersion || undefined : undefined);
  const directDetail = useHelmChartSourceDetail(isUrl ? { url: pick.customRef } : undefined);
  const detail = isOci ? ociDetail.data : isUrl ? directDetail.data : isHub ? urlDetail.data : repoDetail.data;
  const detailLoading = isOci ? ociDetail.isLoading : isUrl ? directDetail.isLoading : isHub ? hubInfo.isLoading || urlDetail.isLoading : repoDetail.isLoading;

  const [ctx, setCtx] = useState(contexts[0] ?? '');
  const isProtected = useIsProtected(ctx);
  const [releaseName, setReleaseName] = useState(pick.chart ?? '');
  const [namespace, setNamespace] = useState('default');
  const [createNamespace, setCreateNamespace] = useState(false);
  const { data: namespaces } = useNamespaces(ctx ? [ctx] : []);

  // Values start from the chart's defaults once they arrive; edits stick.
  // When the defaults change under an edited text (version switch), re-base
  // the user's changes onto the new defaults — otherwise every default that
  // differs between the two versions would be submitted as a user override.
  const [valuesText, setValuesText] = useState<string>();
  const [loadedDefaults, setLoadedDefaults] = useState<string>();
  useEffect(() => {
    if (!detail || detail.valuesYaml === loadedDefaults) return;
    setValuesText((current) => {
      if (current === undefined || current === loadedDefaults) return detail.valuesYaml;
      if (loadedDefaults === undefined) return current;
      return rebaseValuesText(current, loadedDefaults, detail.valuesYaml) ?? current;
    });
    setLoadedDefaults(detail.valuesYaml);
  }, [detail, loadedDefaults]);

  const [tab, setTab] = useState<'values' | 'readme'>('values');
  const [previewTab, setPreviewTab] = useState<'manifest' | 'computed'>('manifest');
  const [formError, setFormError] = useState<string>();
  const [preview, setPreview] = useState<HelmDryRunResult>();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const install = useHelmInstall();
  const dryRunMut = useHelmInstallDryRun();
  const busy = install.isPending || dryRunMut.isPending;

  const chartRef = (): HelmChartSourceRef | undefined => {
    if (isOci) return ociVersion ? { ociRef: pick.customRef, version: ociVersion } : undefined;
    if (isUrl) return { url: pick.customRef };
    if (isHub) return repoUrl && pick.chart && effectiveVersion ? { repoUrl, chart: pick.chart, version: effectiveVersion } : undefined;
    return pick.repo && pick.chart && effectiveVersion ? { repo: pick.repo, chart: pick.chart, version: effectiveVersion } : undefined;
  };

  const buildVars = () => {
    const ref = chartRef();
    if (!ref) {
      setFormError(isOci ? 'Enter the chart version (OCI tag) to install.' : 'Pick a chart version first.');
      return undefined;
    }
    if (!ctx || !releaseName.trim() || !namespace.trim()) {
      setFormError('Cluster, release name and namespace are required.');
      return undefined;
    }
    const { values, error } = parseValues(valuesText ?? '');
    if (error) {
      setFormError(error);
      return undefined;
    }
    setFormError(undefined);
    const overrides = detail ? valuesOverrides(detail.values, values!) : values!;
    return { ctx, name: releaseName.trim(), namespace: namespace.trim(), values: overrides, chart: ref, createNamespace };
  };

  const runPreview = () => {
    const vars = buildVars();
    if (!vars) return;
    dryRunMut.mutate(vars, { onSuccess: setPreview, onError: (e) => setFormError(e.message) });
  };

  const runInstall = () => {
    const vars = buildVars();
    if (!vars) return;
    setConfirmOpen(false);
    install.mutate(vars, {
      onSuccess: () => {
        onClose();
        showToast('info', `Install started for ${vars.namespace}/${vars.name}. Progress is shown on the Helm Releases page.`);
      },
      onError: (e) => setFormError(e.message),
    });
  };

  const title = pick.chart ?? pick.customRef ?? '';
  const readmeSource = preferredChartSource(detail?.sources, detail?.home);

  return (
    <>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <IconButton size="small" onClick={onBack} aria-label="Back to catalog">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          {detail?.icon && <Avatar src={detail.icon} variant="rounded" sx={{ width: 28, height: 28, bgcolor: 'transparent' }} />}
          <Typography variant="h6">{title}</Typography>
          {pick.repo && <Chip size="small" label={pick.repo} variant="outlined" />}
          {pick.hubRepo && <Chip size="small" label={`${pick.hubRepo} · Artifact Hub`} variant="outlined" />}
          {detail?.appVersion && <Chip size="small" label={`app ${detail.appVersion}`} variant="outlined" />}
          <ChartSourceLink url={readmeSource} />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Kubus checks workload readiness in the background. You can leave this dialog and follow the operation from the releases page.
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1, gap: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
          {isOci ? (
            <TextField size="small" label="Version (OCI tag)" value={ociVersion} onChange={(e) => setOciVersion(e.target.value)} sx={{ width: 160 }} />
          ) : !isUrl ? (
            <TextField select size="small" label="Version" value={effectiveVersion ?? ''} onChange={(e) => setVersion(e.target.value)} sx={{ minWidth: 150 }}>
              {(versions ?? []).map((v) => (
                <MenuItem key={v.version} value={v.version}>
                  {v.version}
                  {v.appVersion ? ` (app ${v.appVersion})` : ''}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
          {contexts.length > 1 && (
            <TextField select size="small" label="Cluster" value={ctx} onChange={(e) => setCtx(e.target.value)} sx={{ minWidth: 150 }}>
              {contexts.map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField size="small" label="Release name" value={releaseName} onChange={(e) => setReleaseName(e.target.value)} sx={{ width: 180 }} />
          <TextField select size="small" label="Namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} sx={{ minWidth: 150 }}>
            {[...new Set(['default', ...(namespaces ?? []), ...(namespace ? [namespace] : [])])].sort().map((n) => (
              <MenuItem key={n} value={n}>
                {n}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="…or new namespace"
            placeholder="my-namespace"
            onChange={(e) => {
              setNamespace(e.target.value);
              setCreateNamespace(true);
            }}
            sx={{ width: 160 }}
          />
          <FormControlLabel
            control={<Checkbox size="small" checked={createNamespace} onChange={(e) => setCreateNamespace(e.target.checked)} />}
            label="Create namespace"
          />
        </Stack>
        {formError && (
          <Alert severity="error" onClose={() => setFormError(undefined)}>
            {formError}
          </Alert>
        )}
        {detail?.dependencies?.length ? (
          <Typography variant="caption" color="text.secondary">
            Dependencies: {detail.dependencies.map((d) => `${d.name}@${d.version}`).join(', ')}
          </Typography>
        ) : null}
        <Tabs value={tab} onChange={(_e, v) => setTab(v as 'values' | 'readme')} sx={{ minHeight: 32, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="values" label="Values" sx={{ minHeight: 32, py: 0 }} />
          {detail?.readme && <Tab value="readme" label="README" sx={{ minHeight: 32, py: 0 }} />}
        </Tabs>
        {tab === 'values' && detail ? (
          <Typography variant="caption" color="text.secondary">
            Edit the chart defaults below. Kubus stores only your changes as release overrides, so future chart defaults can still evolve.
          </Typography>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0, border: 1, borderColor: 'divider' }}>
          {tab === 'values' ? (
            detailLoading && valuesText === undefined ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Editor
                language="yaml"
                value={valuesText ?? ''}
                onChange={(v) => setValuesText(v ?? '')}
                theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
                options={{ minimap: { enabled: false }, fontSize: monoFontSize, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, fixedOverflowWidgets: true }}
              />
            )
          ) : (
            <ChartMarkdown markdown={detail?.readme ?? ''} sourceUrl={readmeSource} />
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={runPreview} disabled={busy}>
          {dryRunMut.isPending ? 'Rendering…' : 'Preview manifest'}
        </Button>
        <Button variant="contained" disabled={busy} onClick={() => (isProtected ? setConfirmOpen(true) : runInstall())}>
          {install.isPending ? 'Starting…' : 'Install'}
        </Button>
      </DialogActions>
      {preview && (
        <Dialog open onClose={() => setPreview(undefined)} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: '85vh' } } }}>
          <DialogTitle sx={{ pb: 0.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="h6">Rendered manifest</Typography>
              <Chip size="small" label={`${preview.chart}-${preview.chartVersion}`} variant="outlined" />
              {preview.hooks.length > 0 && <Chip size="small" label={`${preview.hooks.length} hooks`} variant="outlined" />}
              <Box sx={{ flex: 1 }} />
              <Tabs value={previewTab} onChange={(_event, value) => setPreviewTab(value as 'manifest' | 'computed')} sx={{ minHeight: 32 }}>
                <Tab value="manifest" label="Manifest" sx={{ minHeight: 32, py: 0 }} />
                <Tab value="computed" label="Computed values" sx={{ minHeight: 32, py: 0 }} />
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
                Kubernetes rejected {preview.validation.filter((item) => item.status === 'error').length} rendered resource(s) in server-side dry-run. Expand the
                manifest and fix these before installing:{' '}
                {preview.validation
                  .filter((item) => item.status === 'error')
                  .slice(0, 3)
                  .map((item) => `${item.resource}: ${item.message}`)
                  .join('; ')}
              </Alert>
            ) : (
              <Alert severity="success" sx={{ mb: 1 }}>
                Rendered successfully; {preview.validation.filter((item) => item.status === 'valid').length} resources passed Kubernetes server-side dry-run
                {preview.validation.some((item) => item.status === 'warning')
                  ? ` (${preview.validation.filter((item) => item.status === 'warning').length} could not be fully validated)`
                  : ''}
                .
              </Alert>
            )}
            <Box sx={{ flex: 1, minHeight: 0, border: 1, borderColor: 'divider' }}>
              <Editor
                language="yaml"
                value={previewTab === 'manifest' ? preview.manifest : dumpYaml(preview.computedValues, { noRefs: true })}
                theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
                options={{ readOnly: true, minimap: { enabled: false }, fontSize: monoFontSize, scrollBeyondLastLine: false }}
              />
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPreview(undefined)}>Back</Button>
            <Button
              variant="contained"
              disabled={busy || preview.validation.some((item) => item.status === 'error')}
              onClick={() => (isProtected ? setConfirmOpen(true) : runInstall())}
            >
              Install
            </Button>
          </DialogActions>
        </Dialog>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`Install ${releaseName}`}
        confirmLabel="Install"
        busy={install.isPending}
        confirmText={releaseName}
        message={
          <>
            Install <b>{namespace}/{releaseName}</b> on protected cluster <b>{ctx}</b>?
          </>
        }
        onClose={() => setConfirmOpen(false)}
        onConfirm={runInstall}
      />
    </>
  );
}
