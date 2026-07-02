import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { dump as dumpYaml } from 'js-yaml';
import type { KubeconfigImportResponse } from '@kubus/shared';
import { useImportKubeconfig, useSetSshHost } from '../../api/queries.js';
import { ApiError } from '../../api/http.js';
import { SshJumpHostField, SSH_DESTINATION_RE } from './SshJumpHostField.js';
import { normalizePemInput } from './pem.js';

interface Props {
  primaryPath: string | null;
  onClose: () => void;
}

type AuthMethod = 'token' | 'client-cert';
type ConnMode = 'direct' | 'ssh' | 'proxy';

const PROXY_URL_RE = /^(socks5?|socks5h|https?):\/\//i;

/** Build a one-context kubeconfig document from the manual form fields. */
function buildKubeconfigYaml(form: { name: string; server: string; ca: string; skipTls: boolean; auth: AuthMethod; token: string; cert: string; key: string }, proxyUrl?: string): string {
  const cluster: Record<string, unknown> = { server: form.server.trim() };
  if (proxyUrl) cluster['proxy-url'] = proxyUrl;
  if (form.skipTls) cluster['insecure-skip-tls-verify'] = true;
  else if (form.ca.trim()) cluster['certificate-authority-data'] = btoa(normalizePemInput(form.ca) + '\n');
  const user: Record<string, unknown> =
    form.auth === 'token'
      ? { token: form.token.trim() }
      : { 'client-certificate-data': btoa(normalizePemInput(form.cert) + '\n'), 'client-key-data': btoa(normalizePemInput(form.key) + '\n') };
  const name = form.name.trim();
  return dumpYaml({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name, cluster }],
    users: [{ name: `${name}-user`, user }],
    contexts: [{ name, context: { cluster: name, user: `${name}-user` } }],
    'current-context': name,
  });
}

/** Merge a new cluster into the kubeconfig file: paste a config or fill in the form. */
export function AddClusterDialog({ primaryPath, onClose }: Props) {
  const importKubeconfig = useImportKubeconfig();
  const setSshHost = useSetSshHost();
  const [mode, setMode] = useState(0);
  const [pasted, setPasted] = useState('');
  const [form, setForm] = useState({ name: '', server: '', ca: '', skipTls: false, auth: 'token' as AuthMethod, token: '', cert: '', key: '' });
  const [connMode, setConnMode] = useState<ConnMode>('direct');
  const [sshHost, setSshHostValue] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [conflicts, setConflicts] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sshWarning, setSshWarning] = useState<string | null>(null);
  const [result, setResult] = useState<KubeconfigImportResponse | null>(null);

  const sshSelected = connMode === 'ssh';
  // The proxy URL lands in the generated kubeconfig, so it's manual-form-only;
  // for pasted configs put `proxy-url` in the YAML itself.
  const proxySelected = connMode === 'proxy' && mode === 1;
  const connValid = (!sshSelected || SSH_DESTINATION_RE.test(sshHost.trim())) && (!proxySelected || PROXY_URL_RE.test(proxyUrl.trim()));
  const formValid =
    !!form.name.trim() &&
    !!form.server.trim() &&
    (form.auth === 'token' ? !!form.token.trim() : !!form.cert.trim() && !!form.key.trim());

  const switchTab = (v: number) => {
    setMode(v);
    if (v === 0 && connMode === 'proxy') setConnMode('direct');
  };

  const submit = (overwrite: boolean) => {
    setError(null);
    setConflicts(null);
    setSshWarning(null);
    setResult(null);
    let yamlBody: string;
    try {
      yamlBody = mode === 0 ? pasted : buildKubeconfigYaml(form, proxySelected ? proxyUrl.trim() : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    importKubeconfig.mutate(
      { yaml: yamlBody, overwrite },
      {
        onSuccess: async (resp) => {
          // Attach the managed tunnel to every context the import created.
          if (sshSelected && sshHost.trim()) {
            for (const ctxName of resp.added.contexts) {
              try {
                await setSshHost.mutateAsync({ ctx: ctxName, body: { sshHost: sshHost.trim() } });
              } catch (err) {
                setSshWarning(`Imported, but setting the SSH jump host on "${ctxName}" failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
          setResult(resp);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) setConflicts(err.message);
          else setError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  };

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const busy = importKubeconfig.isPending || setSshHost.isPending;
  const addedContexts = result?.added.contexts ?? [];

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add cluster</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <Tabs value={mode} onChange={(_, v: number) => switchTab(v)} sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36 } }}>
          <Tab label="Paste kubeconfig" />
          <Tab label="Manual" />
        </Tabs>
        {mode === 0 ? (
          <TextField
            multiline
            minRows={10}
            maxRows={18}
            fullWidth
            placeholder={'apiVersion: v1\nkind: Config\nclusters:\n  - name: my-cluster\n    …'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
          />
        ) : (
          <Stack spacing={2}>
            <TextField label="Name" size="small" value={form.name} onChange={(e) => set('name', e.target.value)} helperText="Used as cluster and context name" />
            <TextField label="API server URL" size="small" value={form.server} onChange={(e) => set('server', e.target.value)} placeholder="https://1.2.3.4:6443" />
            <FormControlLabel
              control={<Checkbox size="small" checked={form.skipTls} onChange={(e) => set('skipTls', e.target.checked)} />}
              label="Skip TLS verification (insecure)"
            />
            {!form.skipTls && (
              <TextField
                label="CA certificate (optional)"
                multiline
                minRows={3}
                value={form.ca}
                onChange={(e) => set('ca', e.target.value)}
                helperText="PEM, or the base64 certificate-authority-data value from a kubeconfig"
                slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
              />
            )}
            <FormControl size="small">
              <InputLabel id="add-cluster-auth">Authentication</InputLabel>
              <Select labelId="add-cluster-auth" label="Authentication" value={form.auth} onChange={(e) => set('auth', e.target.value as AuthMethod)}>
                <MenuItem value="token">Bearer token</MenuItem>
                <MenuItem value="client-cert">Client certificate</MenuItem>
              </Select>
            </FormControl>
            {form.auth === 'token' ? (
              <TextField label="Token" size="small" value={form.token} onChange={(e) => set('token', e.target.value)} />
            ) : (
              <>
                <TextField
                  label="Client certificate"
                  multiline
                  minRows={3}
                  value={form.cert}
                  onChange={(e) => set('cert', e.target.value)}
                  helperText="PEM or base64 kubeconfig data"
                  slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
                />
                <TextField
                  label="Client key"
                  multiline
                  minRows={3}
                  value={form.key}
                  onChange={(e) => set('key', e.target.value)}
                  helperText="PEM or base64 kubeconfig data"
                  slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
                />
              </>
            )}
            <Typography variant="caption" color="text.secondary">
              Cloud-provider clusters (EKS/GKE/AKS) usually need exec-plugin auth — paste their generated kubeconfig instead.
            </Typography>
          </Stack>
        )}
        <Divider textAlign="left" sx={{ '&::before': { width: 0 } }}>
          <Typography variant="caption" color="text.secondary">
            Only if the cluster isn&apos;t reachable directly
          </Typography>
        </Divider>
        <FormControl size="small">
          <InputLabel id="add-conn">Connection</InputLabel>
          <Select labelId="add-conn" label="Connection" value={connMode} onChange={(e) => setConnMode(e.target.value as ConnMode)}>
            <MenuItem value="direct">Direct — the API server is reachable from this machine</MenuItem>
            <MenuItem value="ssh">SSH jump host — Kubus opens the tunnel for you</MenuItem>
            {mode === 1 && <MenuItem value="proxy">Proxy URL — an existing SOCKS or HTTP proxy</MenuItem>}
          </Select>
        </FormControl>
        {sshSelected && <SshJumpHostField value={sshHost} onChange={setSshHostValue} />}
        {sshSelected && mode === 0 && (
          <Typography variant="caption" color="text.secondary">
            Applied to every context this import adds.
          </Typography>
        )}
        {proxySelected && (
          <TextField
            label="Proxy"
            size="small"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder="socks5://host:port"
            error={!!proxyUrl.trim() && !PROXY_URL_RE.test(proxyUrl.trim())}
            helperText="Written into the kubeconfig as proxy-url"
          />
        )}
        <Typography variant="caption" color="text.secondary">
          Merged into <code>{primaryPath ?? '(no kubeconfig path resolved)'}</code>; a backup is written first.
        </Typography>
        {conflicts && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" disabled={busy} onClick={() => submit(true)}>
                Replace existing
              </Button>
            }
          >
            {conflicts}
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {sshWarning && <Alert severity="warning">{sshWarning}</Alert>}
        {result && (
          <Alert severity="success">
            {addedContexts.length > 0 ? `Added context${addedContexts.length > 1 ? 's' : ''}: ${addedContexts.join(', ')}.` : 'Nothing new to add.'}
            {sshSelected && !sshWarning && addedContexts.length > 0 && ` SSH tunnel via ${sshHost.trim()} configured.`}
            {result.skipped.length > 0 && ` Skipped ${result.skipped.length} identical entr${result.skipped.length > 1 ? 'ies' : 'y'}.`}
            {result.backupPath && ` Backup: ${result.backupPath}`}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button variant="contained" disabled={busy || !connValid || (mode === 0 ? !pasted.trim() : !formValid)} onClick={() => submit(false)}>
          Import
        </Button>
      </DialogActions>
    </Dialog>
  );
}
