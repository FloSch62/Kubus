import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
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
import { alpha, type Theme } from '@mui/material/styles';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CloseIcon from '@mui/icons-material/Close';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import ShieldIcon from '@mui/icons-material/Shield';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
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
import { SettingRow, SettingsGroup, SettingsPage } from './SettingsLayout.js';
import { isBuiltInDebugImage, mergeDebugPresets } from '../../debug-presets.js';
import { fetchAppLogs, formatLogEntry } from '../../api/logs.js';
import { exportFilename, saveTextFile } from '../../save-file.js';
import { showErrorToast } from '../../state/toast.js';
import { useUiStore } from '../../state/ui.js';
import { useShellPrefsStore } from '../../state/shell-prefs.js';

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

const TAG_SX = { height: 18, fontSize: 10 } as const;

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
    <Box sx={{ px: 2, py: 1.25, '& + &': { borderTop: 1, borderColor: 'divider' } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 600, minWidth: 0 }} title={c.name}>
              {c.name}
            </Typography>
            {c.sshHost && (
              <Tooltip title={`Kubus-managed SSH tunnel via ${c.sshHost}`}>
                <Chip size="small" label="ssh jump" sx={TAG_SX} />
              </Tooltip>
            )}
            {c.proxyUrl && !c.sshHost && <Chip size="small" label={c.proxyFromEnv ? 'env proxy' : 'proxy'} sx={TAG_SX} />}
            {c.skipTlsVerify && <Chip size="small" color="warning" variant="outlined" label="insecure" sx={TAG_SX} />}
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap component="div" sx={{ fontFamily: 'monospace', fontSize: 11.5 }}>
            {c.server ?? c.cluster}
            {c.kubernetesVersion ? ` · ${c.kubernetesVersion}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
          <Tooltip title="Edit cluster (server, credentials, SSH jump host or proxy, certificate)">
            <IconButton size="small" aria-label={`Edit ${c.name}`} onClick={() => setEditOpen(true)}>
              <EditOutlinedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={isProtected ? 'Protected: destructive actions require typed confirmation' : 'Mark as protected (e.g. production)'}>
            <IconButton size="small" aria-label={isProtected ? `Unprotect ${c.name}` : `Protect ${c.name}`} aria-pressed={isProtected} onClick={onToggleProtected}>
              {isProtected ? <ShieldIcon color="warning" sx={{ fontSize: 18 }} /> : <ShieldOutlinedIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Remove from kubeconfig">
            <IconButton
              size="small"
              aria-label={`Remove ${c.name}`}
              onClick={() => {
                del.reset();
                setDeleteOpen(true);
              }}
            >
              <DeleteOutlinedIcon color="error" sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>
      {authHint && (
        <Alert severity="warning" sx={{ py: 0, mt: 1 }}>
          {authHint}
        </Alert>
      )}
      {networkHint && (
        <Alert severity="warning" sx={{ py: 0, mt: 1 }}>
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
  const list = contexts ?? [];

  return (
    <SettingsPage title="Clusters" description="The contexts in your kubeconfig. Change how Kubus reaches them, or guard the ones that matter.">
      <SettingsGroup title="Production guard">
        <SettingRow
          label="Protect clusters by default"
          labelFor="settings-protect-default"
          description="Destructive actions require typing the resource name, unless a cluster is explicitly unprotected."
          control={
            <Switch id="settings-protect-default" checked={protectByDefault} onChange={(e) => setPrefs({ protectByDefault: e.target.checked })} />
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title={list.length ? `Clusters · ${list.length}` : 'Clusters'}
        action={
          <Button size="small" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
            Add cluster
          </Button>
        }
        flush
      >
        {list.map((c) => {
          const isProtected = contextSettings[c.name]?.protected ?? protectByDefault;
          return (
            <ClusterRow key={c.name} c={c} isProtected={isProtected} onToggleProtected={() => setContextSetting(c.name, { protected: !isProtected })} />
          );
        })}
        {list.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2.5, textAlign: 'center' }}>
            No clusters yet. Use <strong>Add cluster</strong> to paste or enter one.
          </Typography>
        )}
      </SettingsGroup>
      <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
        Cluster behind a bastion? Open its edit dialog (<EditOutlinedIcon sx={{ fontSize: 12, verticalAlign: 'text-top' }} />) and set an SSH jump
        host, and Kubus manages the tunnel. A proxy URL works too.
      </Typography>
      {addOpen && <AddClusterDialog primaryPath={kubeconfig?.primaryPath ?? null} onClose={() => setAddOpen(false)} />}
    </SettingsPage>
  );
}

function AppearanceSection() {
  const themeMode = useClustersStore((s) => s.themeMode);
  const setTheme = useClustersStore((s) => s.setTheme);
  const { tableDensity, monoFontSize } = useUiPrefsStore();
  const setPrefs = useUiPrefsStore((s) => s.set);

  return (
    <SettingsPage title="Appearance" description="How Kubus looks on this machine.">
      <SettingsGroup>
        <SettingRow
          label="Theme"
          description="System follows your operating system's light or dark setting."
          control={
            <ToggleButtonGroup
              size="small"
              exclusive
              aria-label="Theme"
              value={themeMode}
              onChange={(_, v: 'light' | 'dark' | 'os' | null) => {
                if (v) setTheme(v);
              }}
            >
              <ToggleButton value="light">Light</ToggleButton>
              <ToggleButton value="dark">Dark</ToggleButton>
              <ToggleButton value="os">System</ToggleButton>
            </ToggleButtonGroup>
          }
        />
        <SettingRow
          label="Table density"
          description="Row height in resource lists."
          control={
            <ToggleButtonGroup
              size="small"
              exclusive
              aria-label="Table density"
              value={tableDensity}
              onChange={(_, v: TableDensity | null) => {
                if (v) setPrefs({ tableDensity: v });
              }}
            >
              <ToggleButton value="compact">Compact</ToggleButton>
              <ToggleButton value="comfortable">Comfortable</ToggleButton>
            </ToggleButtonGroup>
          }
        />
        <SettingRow
          label="Code font size"
          description="Logs, YAML editors, diffs and terminals. Terminals pick it up when they open."
          control={
            <>
              <Slider
                size="small"
                min={10}
                max={18}
                step={1}
                marks
                value={monoFontSize}
                aria-label="Code font size"
                onChange={(_, v) => setPrefs({ monoFontSize: v as number })}
                sx={{ width: 180 }}
              />
              <Typography variant="body2" sx={{ width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                {monoFontSize}px
              </Typography>
            </>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

const REFRESH_OPTIONS: Array<{ value: RefreshRate; label: string; hint: string }> = [
  { value: 'fast', label: 'Fast', hint: 'Polls about twice as often as normal.' },
  { value: 'normal', label: 'Normal', hint: 'The default polling intervals.' },
  { value: 'slow', label: 'Slow', hint: 'Polls about half as often as normal.' },
  { value: 'off', label: 'Paused', hint: 'No background polling.' },
];

function RefreshSection() {
  const refreshRate = useUiPrefsStore((s) => s.refreshRate);
  const setPrefs = useUiPrefsStore((s) => s.set);
  return (
    <SettingsPage
      title="Data & refresh"
      description="Resource lists and Helm releases stay live over a watch no matter what. Metrics, events and the overview are polled."
    >
      <SettingsGroup>
        <SettingRow
          label="Background refresh"
          description={REFRESH_OPTIONS.find((o) => o.value === refreshRate)?.hint}
          control={
            <ToggleButtonGroup
              size="small"
              exclusive
              aria-label="Background refresh"
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
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

const SHELL_PRESETS = ['auto', 'sh', 'bash'] as const;

/** A compact select for the right-hand side of a setting row. */
function RowSelect<T extends string | number>({
  id,
  label,
  value,
  onChange,
  width = 180,
  options,
}: {
  id: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  width?: number;
  options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <FormControl size="small" sx={{ width }}>
      <Select
        id={id}
        value={value}
        inputProps={{ 'aria-label': label }}
        onChange={(e) => onChange(e.target.value as T)}
        MenuProps={{ slotProps: { paper: { sx: { maxWidth: 420 } } } }}
      >
        {options.map(([v, text]) => (
          <MenuItem key={String(v)} value={v}>
            {text}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function LogsTerminalSection() {
  const { defaultTailLines, defaultShell, copyOnSelect, rightClickAction } = useUiPrefsStore();
  const setPrefs = useUiPrefsStore((s) => s.set);
  const { wrap, tsMode, highlight, setWrap, setTsMode, setHighlight } = useLogPrefsStore();
  const shellPreset = (SHELL_PRESETS as readonly string[]).includes(defaultShell) ? defaultShell : 'custom';

  return (
    <SettingsPage title="Logs & terminal" description="Defaults for new log tabs and terminals. Each log tab can still change them from its View menu.">
      <SettingsGroup title="Log viewer">
        <SettingRow
          label="Tail lines"
          description="How many recent lines a live log tab starts with."
          control={
            <RowSelect
              id="settings-tail"
              label="Tail lines (live view)"
              value={defaultTailLines}
              width={120}
              onChange={(v) => setPrefs({ defaultTailLines: Number(v) })}
              options={TAIL_LINE_OPTIONS.map((n) => [n, n.toLocaleString()] as const)}
            />
          }
        />
        <SettingRow
          label="Wrap long lines"
          labelFor="settings-wrap"
          control={<Switch id="settings-wrap" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />}
        />
        <SettingRow
          label="Syntax highlighting"
          labelFor="settings-highlight"
          description="Colours JSON and logfmt fields and log levels."
          control={<Switch id="settings-highlight" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />}
        />
        <SettingRow
          label="Timestamps"
          description="The time column in front of each line."
          control={
            <RowSelect<TsMode>
              id="settings-ts"
              label="Timestamps"
              value={tsMode}
              width={140}
              onChange={setTsMode}
              options={[
                ['off', 'Hidden'],
                ['local', 'Local time'],
                ['utc', 'UTC'],
              ]}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Terminal">
        <SettingRow
          label="Default shell"
          description="Used by newly opened exec terminals."
          control={
            <RowSelect
              id="settings-shell"
              label="Default shell"
              value={shellPreset}
              width={270}
              onChange={(v) => setPrefs({ defaultShell: v === 'custom' ? '/bin/zsh' : v })}
              options={[
                ['auto', 'Auto (bash, else sh)'],
                ['sh', 'sh'],
                ['bash', 'bash'],
                ['custom', 'Custom…'],
              ]}
            />
          }
        />
        {shellPreset === 'custom' && (
          <SettingRow
            label="Shell path"
            labelFor="settings-shell-path"
            description="Any shell that exists in the container image."
            control={
              <TextField
                id="settings-shell-path"
                size="small"
                value={defaultShell}
                onChange={(e) => setPrefs({ defaultShell: e.target.value })}
                slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
                sx={{ width: 270 }}
              />
            }
          />
        )}
        <SettingRow
          label="Copy on select"
          labelFor="settings-copy-on-select"
          description="Copy selected terminal text to the clipboard automatically."
          control={<Switch id="settings-copy-on-select" checked={copyOnSelect} onChange={(e) => setPrefs({ copyOnSelect: e.target.checked })} />}
        />
        <SettingRow
          label="Right-click"
          description="What a right-click in a terminal does."
          control={
            <RowSelect<RightClickAction>
              id="settings-terminal-right-click"
              label="Right-click"
              value={rightClickAction}
              width={270}
              onChange={(v) => setPrefs({ rightClickAction: v })}
              options={[
                ['copy-paste', 'Copy selection, otherwise paste'],
                ['paste', 'Always paste'],
                ['menu', 'Show context menu'],
              ]}
            />
          }
        />
      </SettingsGroup>
    </SettingsPage>
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
    <SettingsPage
      title="Debug containers"
      description={
        <>
          The images offered when you start a debug container on a pod or a node (<b>Debug container…</b> in their menus). A profile on an entry
          is pre-selected with it.
        </>
      }
    >
      <SettingsGroup title={`Image catalog · ${catalog.length}`} flush>
        {catalog.map((p) => {
          const custom = customNames.has(p.name);
          return (
            <Box key={p.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1.1, '& + &': { borderTop: 1, borderColor: 'divider' } }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {p.name}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={custom ? (isBuiltInDebugImage(p.name) ? 'replaces built-in' : 'custom') : 'built-in'}
                    color={custom ? 'info' : 'default'}
                    sx={TAG_SX}
                  />
                  {p.profile && p.profile !== 'general' && <Chip size="small" variant="outlined" label={DEBUG_PROFILE_LABELS[p.profile]} sx={TAG_SX} />}
                </Stack>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.5 }}>
                  <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 11.5, color: 'text.primary', opacity: 0.8 }}>
                    {p.image}
                  </Box>
                  {p.description && <> · {p.description}</>}
                </Typography>
              </Box>
              {custom && (
                <Tooltip title={isBuiltInDebugImage(p.name) ? 'Remove and restore the built-in entry' : 'Remove'}>
                  <IconButton size="small" aria-label={`Remove ${p.name}`} disabled={remove.isPending} onClick={() => remove.mutate(p.name)}>
                    <DeleteOutlinedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          );
        })}
      </SettingsGroup>
      <SettingsGroup
        title="Add image"
        description={
          <>
            An internal toolbox, a different busybox tag, anything your registry serves. An entry named like a built-in replaces it. Kept in the
            server-side <code>settings.json</code>, next to your Helm repositories.
          </>
        }
      >
        <Box sx={{ p: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '160px 1fr 170px' }, gap: 1.25 }}>
          <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            size="small"
            label="Image"
            placeholder="registry.example.com/debug:tag"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          <FormControl size="small">
            <InputLabel id="settings-debug-image-profile">Profile</InputLabel>
            <Select labelId="settings-debug-image-profile" label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
              <MenuItem value="">General (default)</MenuItem>
              <MenuItem value="restricted">Restricted</MenuItem>
              <MenuItem value="netadmin">Network admin</MenuItem>
              <MenuItem value="sysadmin">System admin</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            sx={{ gridColumn: { sm: '1 / 3' } }}
          />
          <Button
            variant="contained"
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
            Add image
          </Button>
          {error && (
            <Alert severity="error" variant="outlined" sx={{ gridColumn: '1 / -1' }}>
              {error.message}
            </Alert>
          )}
        </Box>
      </SettingsGroup>
    </SettingsPage>
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
            `# Kubus diagnostic log, exported ${new Date().toISOString()}`,
            `# ${logs.entries.length} entries, debug logging ${logs.debugEnabled ? 'on' : 'off'}`,
            ...logs.entries.map(formatLogEntry),
          ].join('\n'),
        );
      })
      .catch(showErrorToast);
  };

  return (
    <SettingsPage
      title="Diagnostics"
      description="Kubus keeps its own log in memory on this machine. It never leaves it unless you export it, for example to attach to a bug report."
    >
      <SettingsGroup>
        <SettingRow
          label="Capture verbose diagnostic logs"
          labelFor="settings-debug-mode"
          description="Records cluster discovery, API access, watches, port forwards and Helm operations in more detail. Warnings and errors are always captured."
          control={<Switch id="settings-debug-mode" checked={debugMode} onChange={(event) => setPrefs({ debugMode: event.target.checked })} />}
        />
        <SettingRow
          label="Application log"
          description="Everything since launch. If the desktop app fails to start at all, its shell also writes logs/main.log in the app data directory."
          control={
            <>
              <Button variant="outlined" size="small" startIcon={<ArticleOutlinedIcon />} onClick={() => setLogViewerOpen(true)}>
                View logs
              </Button>
              <Button variant="outlined" size="small" startIcon={<DownloadOutlinedIcon />} onClick={exportLogs}>
                Export logs
              </Button>
            </>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

const TABS = ['Kubeconfig', 'Clusters', 'Appearance', 'Data & refresh', 'Logs & terminal', 'Debug containers', 'Diagnostics', 'About'];
const TAB_ICONS = [
  DescriptionOutlinedIcon,
  HubOutlinedIcon,
  PaletteOutlinedIcon,
  SyncOutlinedIcon,
  TerminalOutlinedIcon,
  BugReportOutlinedIcon,
  MonitorHeartOutlinedIcon,
  InfoOutlinedIcon,
];

/** The selected tab: a primary tint and primary text, like the active nav entry. No indicator bar. */
const TAB_SX = {
  minHeight: 36,
  py: 0.75,
  px: 1.25,
  mx: 1,
  my: 0.125,
  borderRadius: 1.5,
  justifyContent: 'flex-start',
  textAlign: 'left',
  fontSize: 13.5,
  gap: 1.25,
  '& .MuiTab-icon': { fontSize: 18, m: 0, color: 'text.secondary' },
  '&:hover': { bgcolor: 'action.hover' },
  '&.Mui-selected': {
    color: 'primary.main',
    bgcolor: (theme: Theme) => alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.09),
    '& .MuiTab-icon': { color: 'primary.main' },
  },
} as const;

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Reopens where you left it; most visits come back to the same tab.
  const setSettingsTab = useShellPrefsStore((s) => s.setSettingsTab);
  const [tab, setTabState] = useState(() => Math.max(0, TABS.indexOf(useShellPrefsStore.getState().settingsTab ?? '')));
  const setTab = (index: number) => {
    setTabState(index);
    setSettingsTab(TABS[index] ?? TABS[0]!);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      aria-labelledby="settings-dialog-title"
      // One height for every tab, so switching tabs never makes the dialog jump.
      slotProps={{ paper: { sx: { height: 'min(720px, calc(100% - 64px))', overflow: 'hidden' } } }}
    >
      <DialogTitle id="settings-dialog-title" sx={{ display: 'flex', alignItems: 'center', py: 1.5, pl: 2.5, pr: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Box component="span" sx={{ flex: 1, fontSize: 17, fontWeight: 650 }}>
          Settings
        </Box>
        <Tooltip title="Close (Esc)">
          <IconButton aria-label="Close" size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', p: 0, minHeight: 0 }}>
        <Tabs
          orientation="vertical"
          value={tab}
          onChange={(_, v: number) => setTab(v)}
          aria-label="Settings sections"
          variant="scrollable"
          slotProps={{ indicator: { sx: { display: 'none' } } }}
          sx={{
            width: 200,
            flexShrink: 0,
            py: 1,
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: (theme) => (theme.palette.mode === 'dark' ? alpha('#000', 0.12) : alpha(theme.palette.text.primary, 0.02)),
            display: { xs: 'none', sm: 'flex' },
          }}
        >
          {TABS.map((t, i) => {
            const Icon = TAB_ICONS[i]!;
            return <Tab key={t} label={t} icon={<Icon />} iconPosition="start" sx={TAB_SX} />;
          })}
        </Tabs>
        <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto', px: { xs: 2, sm: 3.5 }, py: 3, bgcolor: 'background.default' }}>
          {/* Narrow windows: the section list becomes a picker above the page. */}
          <FormControl size="small" fullWidth sx={{ display: { xs: 'flex', sm: 'none' }, mb: 2.5 }}>
            <Select value={tab} inputProps={{ 'aria-label': 'Settings section' }} onChange={(e) => setTab(Number(e.target.value))}>
              {TABS.map((t, i) => (
                <MenuItem key={t} value={i}>
                  {t}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Box sx={{ maxWidth: 720 }}>
            {tab === 0 && <KubeconfigSection />}
            {tab === 1 && <ClustersSection />}
            {tab === 2 && <AppearanceSection />}
            {tab === 3 && <RefreshSection />}
            {tab === 4 && <LogsTerminalSection />}
            {tab === 5 && <DebugContainersSection />}
            {tab === 6 && <DebugSection />}
            {tab === 7 && <AboutSection />}
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
