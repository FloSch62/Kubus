import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  Link,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import CachedOutlinedIcon from '@mui/icons-material/CachedOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import ShieldIcon from '@mui/icons-material/Shield';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import AddIcon from '@mui/icons-material/Add';
import type { AppInfo, ContextInfo, UpdateCheckResult } from '@kubus/shared';
import { useContexts, useKubeconfigSettings } from '../../api/queries.js';
import { checkForUpdate, getAppInfo } from '../../api/app.js';
import { AddClusterDialog } from './AddClusterDialog.js';
import { EditClusterDialog } from './EditClusterDialog.js';
import { useClustersStore } from '../../state/clusters.js';
import { useLogPrefsStore, type TsMode } from '../../state/log-prefs.js';
import { TAIL_LINE_OPTIONS, useUiPrefsStore, type RefreshRate, type TableDensity } from '../../state/prefs.js';
import { KubeconfigSection } from './KubeconfigSection.js';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/** Connection errors that usually mean the API server isn't directly reachable. */
function looksLikeNetworkError(msg?: string): boolean {
  if (!msg) return false;
  return /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|timed?\s*out|socket hang up|network|getaddrinfo|tunneling socket|certificate|self.?signed/i.test(
    msg,
  );
}

function ClusterRow({ c, isProtected, onToggleProtected }: { c: ContextInfo; isProtected: boolean; onToggleProtected: () => void }) {
  const [editOpen, setEditOpen] = useState(false);
  const networkHint = c.health === 'error' && looksLikeNetworkError(c.healthMessage);

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', py: 0.25 }}>
      <ListItem
        disableGutters
        secondaryAction={
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="Edit cluster (server, credentials, proxy, certificate)">
              <IconButton size="small" onClick={() => setEditOpen(true)}>
                <EditOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title={isProtected ? 'Protected: destructive actions require typed confirmation' : 'Mark as protected (e.g. production)'}>
              <IconButton size="small" onClick={onToggleProtected}>
                {isProtected ? <ShieldIcon color="warning" sx={{ fontSize: 18 }} /> : <ShieldOutlinedIcon sx={{ fontSize: 18 }} />}
              </IconButton>
            </Tooltip>
          </Stack>
        }
      >
        <ListItemText
          primary={
            <Stack direction="row" spacing={0.75} alignItems="center" component="span">
              <span>{c.name}</span>
              {c.proxyUrl && <Chip size="small" label={c.proxyFromEnv ? 'env proxy' : 'proxy'} sx={{ height: 18, fontSize: 10 }} />}
              {c.skipTlsVerify && <Chip size="small" color="warning" variant="outlined" label="insecure" sx={{ height: 18, fontSize: 10 }} />}
            </Stack>
          }
          secondary={`${c.server ?? c.cluster}${c.kubernetesVersion ? ` · ${c.kubernetesVersion}` : ''}`}
          slotProps={{ secondary: { sx: { fontSize: 12 } } }}
        />
      </ListItem>
      {networkHint && (
        <Alert severity="warning" sx={{ py: 0, mb: 0.5 }}>
          Can&apos;t reach the API server. Only reachable through a bastion or proxy?{' '}
          <Link component="button" type="button" onClick={() => setEditOpen(true)} sx={{ verticalAlign: 'baseline' }}>
            Set up a proxy
          </Link>
          .
        </Alert>
      )}
      {editOpen && <EditClusterDialog context={c} onClose={() => setEditOpen(false)} />}
    </Box>
  );
}

function ClustersSection() {
  const { data: contexts } = useContexts();
  const { data: kubeconfig } = useKubeconfigSettings();
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const setContextSetting = useClustersStore((s) => s.setContextSetting);
  const protectByDefault = useUiPrefsStore((s) => s.protectByDefault);
  const setPrefs = useUiPrefsStore((s) => s.set);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <Stack spacing={2}>
      <FormControlLabel
        control={<Switch checked={protectByDefault} onChange={(e) => setPrefs({ protectByDefault: e.target.checked })} />}
        label={
          <Box>
            <Typography variant="body2">Protect clusters by default</Typography>
            <Typography variant="caption" color="text.secondary">
              Destructive actions require typing the resource name unless a cluster is explicitly unprotected
            </Typography>
          </Box>
        }
      />
      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2">Clusters</Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
            Add cluster
          </Button>
        </Stack>
        <List dense disablePadding>
          {(contexts ?? []).map((c) => {
            const isProtected = contextSettings[c.name]?.protected ?? protectByDefault;
            return (
              <ClusterRow
                key={c.name}
                c={c}
                isProtected={isProtected}
                onToggleProtected={() => setContextSetting(c.name, { protected: !isProtected })}
              />
            );
          })}
          {(contexts ?? []).length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No clusters yet. Use <strong>Add cluster</strong> to paste or enter one.
            </Typography>
          )}
        </List>
      </Box>
      {addOpen && <AddClusterDialog primaryPath={kubeconfig?.primaryPath ?? null} onClose={() => setAddOpen(false)} />}
    </Stack>
  );
}

function AppearanceSection() {
  const themeMode = useClustersStore((s) => s.themeMode);
  const setTheme = useClustersStore((s) => s.setTheme);
  const { tableDensity, monoFontSize } = useUiPrefsStore();
  const setPrefs = useUiPrefsStore((s) => s.set);

  return (
    <Stack spacing={3}>
      <Section title="Theme">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={themeMode}
          onChange={(_, v: 'light' | 'dark' | 'os' | null) => {
            if (v) setTheme(v);
          }}
        >
          <ToggleButton value="light">Light</ToggleButton>
          <ToggleButton value="dark">Dark</ToggleButton>
          <ToggleButton value="os">System</ToggleButton>
        </ToggleButtonGroup>
      </Section>
      <Section title="Table density">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={tableDensity}
          onChange={(_, v: TableDensity | null) => {
            if (v) setPrefs({ tableDensity: v });
          }}
        >
          <ToggleButton value="compact">Compact</ToggleButton>
          <ToggleButton value="comfortable">Comfortable</ToggleButton>
        </ToggleButtonGroup>
      </Section>
      <Section title={`Code font size — ${monoFontSize}px`}>
        <Slider
          size="small"
          min={10}
          max={18}
          step={1}
          marks
          value={monoFontSize}
          onChange={(_, v) => setPrefs({ monoFontSize: v as number })}
          sx={{ maxWidth: 320, display: 'block' }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Applies to logs, YAML editors, diffs and terminals (new terminal sessions)
        </Typography>
      </Section>
    </Stack>
  );
}

const REFRESH_OPTIONS: Array<{ value: RefreshRate; label: string; hint: string }> = [
  { value: 'fast', label: 'Fast', hint: '½× intervals' },
  { value: 'normal', label: 'Normal', hint: 'default intervals' },
  { value: 'slow', label: 'Slow', hint: '2× intervals' },
  { value: 'off', label: 'Paused', hint: 'no background polling' },
];

function RefreshSection() {
  const refreshRate = useUiPrefsStore((s) => s.refreshRate);
  const setPrefs = useUiPrefsStore((s) => s.set);
  return (
    <Stack spacing={2}>
      <Section title="Background refresh">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={refreshRate}
          onChange={(_, v: RefreshRate | null) => {
            if (v) setPrefs({ refreshRate: v });
          }}
        >
          {REFRESH_OPTIONS.map((o) => (
            <ToggleButton key={o.value} value={o.value}>
              {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {REFRESH_OPTIONS.find((o) => o.value === refreshRate)?.hint}. Governs polled data (metrics, events, helm releases, overview) — watched
          resource lists stay live over WebSocket regardless.
        </Typography>
      </Section>
    </Stack>
  );
}

const SHELL_PRESETS = ['auto', 'sh', 'bash'] as const;

function LogsTerminalSection() {
  const { defaultTailLines, defaultShell } = useUiPrefsStore();
  const setPrefs = useUiPrefsStore((s) => s.set);
  const { wrap, tsMode, highlight, setWrap, setTsMode, setHighlight } = useLogPrefsStore();
  const shellPreset = (SHELL_PRESETS as readonly string[]).includes(defaultShell) ? defaultShell : 'custom';

  return (
    <Stack spacing={3}>
      <Section title="Log viewer">
        <Stack spacing={1.5}>
          <FormControl size="small" sx={{ maxWidth: 240 }}>
            <InputLabel id="settings-tail">Tail lines (live view)</InputLabel>
            <Select
              labelId="settings-tail"
              label="Tail lines (live view)"
              value={defaultTailLines}
              onChange={(e) => setPrefs({ defaultTailLines: Number(e.target.value) })}
            >
              {TAIL_LINE_OPTIONS.map((n) => (
                <MenuItem key={n} value={n}>
                  {n.toLocaleString()}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel control={<Switch checked={wrap} onChange={(e) => setWrap(e.target.checked)} />} label="Wrap long lines" />
          <FormControlLabel
            control={<Switch checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />}
            label="Syntax highlighting (JSON / logfmt / levels)"
          />
          <FormControl size="small" sx={{ maxWidth: 240 }}>
            <InputLabel id="settings-ts">Timestamps</InputLabel>
            <Select labelId="settings-ts" label="Timestamps" value={tsMode} onChange={(e) => setTsMode(e.target.value as TsMode)}>
              <MenuItem value="off">Hidden</MenuItem>
              <MenuItem value="local">Local time</MenuItem>
              <MenuItem value="utc">UTC</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Section>
      <Section title="Terminal">
        <Stack spacing={1.5}>
          <FormControl size="small" sx={{ maxWidth: 240 }}>
            <InputLabel id="settings-shell">Default shell</InputLabel>
            <Select
              labelId="settings-shell"
              label="Default shell"
              value={shellPreset}
              onChange={(e) => {
                const v = e.target.value;
                setPrefs({ defaultShell: v === 'custom' ? '/bin/zsh' : v });
              }}
            >
              <MenuItem value="auto">Auto (bash, falls back to sh)</MenuItem>
              <MenuItem value="sh">sh</MenuItem>
              <MenuItem value="bash">bash</MenuItem>
              <MenuItem value="custom">Custom…</MenuItem>
            </Select>
          </FormControl>
          {shellPreset === 'custom' && (
            <TextField
              size="small"
              label="Shell path"
              value={defaultShell}
              onChange={(e) => setPrefs({ defaultShell: e.target.value })}
              sx={{ maxWidth: 240 }}
            />
          )}
          <Typography variant="caption" color="text.secondary">
            Applies to newly opened exec terminals
          </Typography>
        </Stack>
      </Section>
    </Stack>
  );
}

function updateReasonLabel(reason?: string): string {
  switch (reason) {
    case 'timeout':
      return 'The update check timed out.';
    case 'network':
      return 'The update check could not reach GitHub.';
    case 'no-release':
      return 'No published release was found.';
    case 'missing-version':
    case 'missing-release-url':
      return 'The latest release metadata is incomplete.';
    default:
      return reason?.startsWith('manifest-')
        ? `The update manifest returned ${reason.replace('manifest-', '')}.`
        : 'The update check could not be completed.';
  }
}

function AboutSection() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkForUpdates = () => {
    setChecking(true);
    setResult(null);
    void checkForUpdate({ force: true })
      .then(setResult)
      .catch(() => setResult({ available: false, currentVersion: appInfo?.version ?? '', reason: 'network' }))
      .finally(() => setChecking(false));
  };

  const version = appInfo?.version ?? (loaded ? 'Unavailable' : 'Loading…');
  const updatesAvailable = result?.available === true;

  return (
    <Stack spacing={3}>
      <Section title="Application">
        <Stack spacing={1.25}>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Version
            </Typography>
            <Typography variant="body2">{version}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Repository
            </Typography>
            <Link href="https://github.com/FloSch62/Kubus" target="_blank" rel="noreferrer">
              github.com/FloSch62/Kubus
            </Link>
          </Box>
        </Stack>
      </Section>
      <Section title="Updates">
        <Stack spacing={1.5} alignItems="flex-start">
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="contained"
              startIcon={checking ? <CircularProgress color="inherit" size={16} /> : <CachedOutlinedIcon />}
              disabled={checking}
              onClick={checkForUpdates}
            >
              Check for updates
            </Button>
            {updatesAvailable && (
              <Button startIcon={<DownloadOutlinedIcon />} href={result.releaseUrl} target="_blank" rel="noreferrer">
                Download
              </Button>
            )}
          </Stack>
          {result?.available === false && result.latestVersion && (
            <Alert severity="success" variant="outlined">
              Kubus is up to date. Latest release: {result.latestVersion}.
            </Alert>
          )}
          {result?.available === false && !result.latestVersion && (
            <Alert severity="warning" variant="outlined">
              {updateReasonLabel(result.reason)}
            </Alert>
          )}
          {updatesAvailable && (
            <Alert severity="info" variant="outlined">
              Kubus {result.latestVersion} is available. You are running {result.currentVersion}.
            </Alert>
          )}
        </Stack>
      </Section>
    </Stack>
  );
}

const TABS = ['Kubeconfig', 'Clusters', 'Appearance', 'Data & refresh', 'Logs & terminal', 'About'];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState(0);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent sx={{ display: 'flex', p: 0, minHeight: 440 }}>
        <Tabs
          orientation="vertical"
          value={tab}
          onChange={(_, v: number) => setTab(v)}
          sx={{ borderRight: 1, borderColor: 'divider', minWidth: 180, flexShrink: 0, pt: 1 }}
        >
          {TABS.map((t) => (
            <Tab key={t} label={t} sx={{ alignItems: 'flex-start', textAlign: 'left', minHeight: 40 }} />
          ))}
        </Tabs>
        <Box sx={{ flex: 1, p: 3, overflow: 'auto' }}>
          {tab === 0 && <KubeconfigSection />}
          {tab === 1 && <ClustersSection />}
          {tab === 2 && <AppearanceSection />}
          {tab === 3 && <RefreshSection />}
          {tab === 4 && <LogsTerminalSection />}
          {tab === 5 && <AboutSection />}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
