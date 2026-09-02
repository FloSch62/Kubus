import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import ShieldIcon from '@mui/icons-material/Shield';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import AddIcon from '@mui/icons-material/Add';
import type { ContextInfo, DebugProfile } from '@kubus/shared';
import { useAddDebugImage, useContexts, useDebugImages, useDeleteCluster, useKubeconfigSettings, useRemoveDebugImage } from '../../api/queries.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { AddClusterDialog } from './AddClusterDialog.js';
import { EditClusterDialog } from './EditClusterDialog.js';
import { useClustersStore } from '../../state/clusters.js';
import { useLogPrefsStore, type TsMode } from '../../state/log-prefs.js';
import { TAIL_LINE_OPTIONS, useUiPrefsStore, type RefreshRate, type RightClickAction, type TableDensity } from '../../state/prefs.js';
import { AboutSection } from './AboutSection.js';
import { KubeconfigSection } from './KubeconfigSection.js';
import { isBuiltInDebugImage, mergeDebugPresets } from '../../debug-presets.js';
import { fetchAppLogs, formatLogEntry } from '../../api/logs.js';
import { exportFilename, saveTextFile } from '../../save-file.js';
import { showErrorToast } from '../../state/toast.js';
import { useUiStore } from '../../state/ui.js';

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

const NETWORK_ERROR_RE =
  /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|timed?\s*out|socket hang up|network|getaddrinfo|tunneling socket|certificate|self.?signed/i;
const AUTH_ERROR_RE = /\b401\b|\b403\b|Unauthorized|Forbidden|credential plugin|auth-provider/i;

/** Connection errors that usually mean the API server isn't directly reachable. */
function looksLikeNetworkError(msg?: string): boolean {
  if (!msg) return false;
  return NETWORK_ERROR_RE.test(msg);
}

/** Failures where the server was reached but the credentials are the problem. */
function looksLikeAuthError(msg?: string): boolean {
  if (!msg) return false;
  return AUTH_ERROR_RE.test(msg);
}

function ClusterRow({ c, isProtected, onToggleProtected }: { c: ContextInfo; isProtected: boolean; onToggleProtected: () => void }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const del = useDeleteCluster();
  // One hint at a time, most actionable first: a proactive credential warning
  // (plugin missing, legacy stanza), then the probe's auth failure, then the
  // "maybe it needs a tunnel" nudge.
  const authHint = c.authWarning ?? (c.health === 'error' && looksLikeAuthError(c.healthMessage) ? c.healthMessage : undefined);
  const networkHint = !authHint && c.health === 'error' && looksLikeNetworkError(c.healthMessage);

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', py: 0.25 }}>
      <ListItem
        disableGutters
        secondaryAction={
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="Edit cluster (server, credentials, SSH jump host / proxy, certificate)">
              <IconButton size="small" onClick={() => setEditOpen(true)}>
                <EditOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title={isProtected ? 'Protected: destructive actions require typed confirmation' : 'Mark as protected (e.g. production)'}>
              <IconButton size="small" onClick={onToggleProtected}>
                {isProtected ? <ShieldIcon color="warning" sx={{ fontSize: 18 }} /> : <ShieldOutlinedIcon sx={{ fontSize: 18 }} />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove from kubeconfig">
              <IconButton
                size="small"
                onClick={() => {
                  del.reset();
                  setDeleteOpen(true);
                }}
              >
                <DeleteOutlinedIcon color="error" sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        }
      >
        <ListItemText
          primary={
            <Stack direction="row" spacing={0.75} component="span" sx={{ alignItems: 'center' }}>
              <span>{c.name}</span>
              {c.sshHost && (
                <Tooltip title={`Kubus-managed SSH tunnel via ${c.sshHost}`}>
                  <Chip size="small" label="ssh jump" sx={{ height: 18, fontSize: 10 }} />
                </Tooltip>
              )}
              {c.proxyUrl && !c.sshHost && <Chip size="small" label={c.proxyFromEnv ? 'env proxy' : 'proxy'} sx={{ height: 18, fontSize: 10 }} />}
              {c.skipTlsVerify && <Chip size="small" color="warning" variant="outlined" label="insecure" sx={{ height: 18, fontSize: 10 }} />}
            </Stack>
          }
          secondary={`${c.server ?? c.cluster}${c.kubernetesVersion ? ` · ${c.kubernetesVersion}` : ''}`}
          slotProps={{ secondary: { sx: { fontSize: 12 } } }}
        />
      </ListItem>
      {authHint && (
        <Alert severity="warning" sx={{ py: 0, mb: 0.5 }}>
          {authHint}
        </Alert>
      )}
      {networkHint && (
        <Alert severity="warning" sx={{ py: 0, mb: 0.5 }}>
          Can&apos;t reach the API server. Only reachable through a bastion or proxy?{' '}
          <Link component="button" type="button" onClick={() => setEditOpen(true)} sx={{ verticalAlign: 'baseline' }}>
            Set up an SSH jump host or proxy
          </Link>
          .
        </Alert>
      )}
      {editOpen && <EditClusterDialog context={c} onClose={() => setEditOpen(false)} />}
      <ConfirmDialog
        open={deleteOpen}
        title="Remove cluster"
        message={
          <>
            Remove <b>{c.name}</b> from the kubeconfig? This deletes the context and any cluster/user entries no other context uses. The cluster
            itself is not touched, and a <code>.kubus.bak</code> backup of the file is kept.
            {del.error instanceof Error && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {del.error.message}
              </Alert>
            )}
          </>
        }
        confirmLabel="Remove"
        danger
        busy={del.isPending}
        confirmText={isProtected ? c.name : undefined}
        onConfirm={() => del.mutate(c.name, { onSuccess: () => setDeleteOpen(false) })}
        onClose={() => setDeleteOpen(false)}
      />
    </Box>
  );
}

function ClustersSection() {
  const { data: contexts } = useContexts({ poll: false });
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
        <Stack direction="row" sx={{ mb: 0.5, alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle2">Clusters</Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
            Add cluster
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Cluster behind a bastion? Open its edit dialog (<EditOutlinedIcon sx={{ fontSize: 12, verticalAlign: 'text-top' }} />) and set an SSH jump
          host — Kubus manages the tunnel — or a proxy URL.
        </Typography>
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
  const { defaultTailLines, defaultShell, copyOnSelect, rightClickAction } = useUiPrefsStore();
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
          <FormControlLabel
            control={<Switch checked={copyOnSelect} onChange={(e) => setPrefs({ copyOnSelect: e.target.checked })} />}
            label={
              <Box>
                <Typography variant="body2">Copy on select</Typography>
                <Typography variant="caption" color="text.secondary">
                  Copy selected terminal text to the clipboard automatically
                </Typography>
              </Box>
            }
          />
          <FormControl size="small" sx={{ maxWidth: 420 }}>
            <InputLabel id="settings-terminal-right-click">Right-click</InputLabel>
            <Select
              labelId="settings-terminal-right-click"
              label="Right-click"
              value={rightClickAction}
              onChange={(e) => setPrefs({ rightClickAction: e.target.value as RightClickAction })}
            >
              <MenuItem value="copy-paste">Copy selection, otherwise paste (terminal convention)</MenuItem>
              <MenuItem value="paste">Always paste</MenuItem>
              <MenuItem value="menu">Show context menu</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Section>
    </Stack>
  );
}

const DEBUG_PROFILE_LABELS: Record<string, string> = { general: 'General', restricted: 'Restricted', netadmin: 'Network admin', sysadmin: 'System admin' };

/** The debug-container image catalog: built-in presets plus user-defined images. */
function DebugContainersSection() {
  const { data: images } = useDebugImages();
  const add = useAddDebugImage();
  const remove = useRemoveDebugImage();
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [profile, setProfile] = useState('');
  const [description, setDescription] = useState('');
  const error = add.error ?? remove.error;
  const catalog = mergeDebugPresets(images);
  const customNames = new Set((images ?? []).map((p) => p.name));

  return (
    <Stack spacing={3}>
      <Section title="Image catalog">
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            The images offered when attaching a debug container to a pod (<b>Debug container…</b> in the pod menu). A profile on an entry is
            pre-selected with it.
          </Typography>
          <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, py: 0 }}>
            {catalog.map((p, i) => {
              const custom = customNames.has(p.name);
              return (
                <ListItem
                  key={p.name}
                  divider={i < catalog.length - 1}
                  secondaryAction={
                    custom ? (
                      <Tooltip title={isBuiltInDebugImage(p.name) ? 'Remove and restore the built-in entry' : 'Remove'}>
                        <IconButton size="small" disabled={remove.isPending} onClick={() => remove.mutate(p.name)}>
                          <DeleteOutlinedIcon sx={{ fontSize: 18 }} />
                        </IconButton>
                      </Tooltip>
                    ) : undefined
                  }
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography variant="body2">{p.name}</Typography>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={custom ? (isBuiltInDebugImage(p.name) ? 'replaces built-in' : 'custom') : 'built-in'}
                          color={custom ? 'info' : 'default'}
                          sx={{ height: 18, fontSize: 10 }}
                        />
                        {p.profile && p.profile !== 'general' && (
                          <Chip size="small" variant="outlined" label={DEBUG_PROFILE_LABELS[p.profile]} sx={{ height: 18, fontSize: 10 }} />
                        )}
                      </Stack>
                    }
                    secondary={p.description ? `${p.image} — ${p.description}` : p.image}
                    slotProps={{ secondary: { sx: { fontSize: 11 } } }}
                  />
                </ListItem>
              );
            })}
          </List>
        </Stack>
      </Section>
      <Section title="Add image">
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            Add your own image — an internal toolbox, a different busybox tag, anything your registry serves. An entry named like a built-in
            replaces it. Stored in the server-side <code>settings.json</code>, next to your Helm repositories.
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} sx={{ width: 170 }} />
            <TextField
              size="small"
              label="Image"
              placeholder="registry.example.com/debug:tag"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              sx={{ flex: 1 }}
            />
            <FormControl size="small" sx={{ width: 170, flexShrink: 0 }}>
              <InputLabel id="settings-debug-image-profile">Profile</InputLabel>
              <Select labelId="settings-debug-image-profile" label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
                <MenuItem value="">General (default)</MenuItem>
                <MenuItem value="restricted">Restricted</MenuItem>
                <MenuItem value="netadmin">Network admin</MenuItem>
                <MenuItem value="sysadmin">System admin</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField size="small" label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} sx={{ flex: 1 }} />
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              disabled={add.isPending || !name.trim() || !image.trim()}
              onClick={() =>
                add.mutate(
                  {
                    name: name.trim(),
                    image: image.trim(),
                    profile: (profile || undefined) as DebugProfile | undefined,
                    description: description.trim() || undefined,
                  },
                  {
                    onSuccess: () => {
                      setName('');
                      setImage('');
                      setProfile('');
                      setDescription('');
                    },
                  },
                )
              }
            >
              Add
            </Button>
          </Stack>
          {error && (
            <Alert severity="error" variant="outlined">
              {error.message}
            </Alert>
          )}
        </Stack>
      </Section>
    </Stack>
  );
}

/** Diagnostic logging: verbose capture plus viewer and export controls. */
function DebugSection() {
  const debugMode = useUiPrefsStore((state) => state.debugMode);
  const setPrefs = useUiPrefsStore((state) => state.set);
  const setLogViewerOpen = useUiStore((state) => state.setLogViewerOpen);

  const exportLogs = () => {
    fetchAppLogs()
      .then((logs) => {
        saveTextFile(
          exportFilename('debug log', 'log'),
          [
            `# Kubus diagnostic log — exported ${new Date().toISOString()}`,
            `# ${logs.entries.length} entries, debug logging ${logs.debugEnabled ? 'on' : 'off'}`,
            ...logs.entries.map(formatLogEntry),
          ].join('\n'),
        );
      })
      .catch(showErrorToast);
  };

  return (
    <Stack spacing={3}>
      <Section title="Debug mode">
        <FormControlLabel
          control={<Switch checked={debugMode} onChange={(event) => setPrefs({ debugMode: event.target.checked })} />}
          label={
            <Box>
              <Typography variant="body2">Capture verbose diagnostic logs</Typography>
              <Typography variant="caption" color="text.secondary">
                Records cluster discovery, API access, watches, port forwards and Helm operations in greater detail. Warnings and errors are always captured, even while this is off.
              </Typography>
            </Box>
          }
        />
      </Section>
      <Section title="Logs">
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" size="small" startIcon={<ArticleOutlinedIcon />} onClick={() => setLogViewerOpen(true)}>
            View logs
          </Button>
          <Button variant="outlined" size="small" startIcon={<DownloadOutlinedIcon />} onClick={exportLogs}>
            Export logs
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Covers app startup and operations since launch. Logs are held in memory on this machine only and never leave it unless you export them. If the desktop app fails to launch entirely, its shell also writes logs/main.log in the app data directory.
        </Typography>
      </Section>
    </Stack>
  );
}

const TABS = ['Kubeconfig', 'Clusters', 'Appearance', 'Data & refresh', 'Logs & terminal', 'Debug containers', 'Diagnostics', 'About'];

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
          {tab === 5 && <DebugContainersSection />}
          {tab === 6 && <DebugSection />}
          {tab === 7 && <AboutSection />}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
