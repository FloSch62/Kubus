import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputAdornment,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import HelpOutlinedIcon from '@mui/icons-material/HelpOutlined';
import type { ClusterAuthType, ContextInfo } from '@kubus/shared';
import { useClusterCa, useEditCluster, useTestConnection } from '../../api/queries.js';
import { SshJumpHostField, SSH_DESTINATION_RE } from './SshJumpHostField.js';

/** A "?" icon that reveals a fuller explanation on hover — keeps field labels short. */
function helpTip(text: string) {
  return (
    <InputAdornment position="end">
      <Tooltip title={text} placement="top" arrow>
        <HelpOutlinedIcon sx={{ fontSize: 16, color: 'text.disabled', cursor: 'help' }} />
      </Tooltip>
    </InputAdornment>
  );
}

const AUTH_LABEL: Record<ClusterAuthType, string> = {
  token: 'bearer token',
  'client-cert': 'client certificate',
  exec: 'exec plugin',
  'auth-provider': 'auth provider',
  basic: 'basic auth',
  none: 'none',
};

type AuthMode = 'keep' | 'token' | 'client-cert';
type ConnMode = 'direct' | 'ssh' | 'proxy';

const PROXY_URL_RE = /^(socks5?|socks5h|https?):\/\//i;

/** Full edit of an existing cluster — same fields as "Add cluster", prefilled. */
export function EditClusterDialog({ context: c, onClose }: { context: ContextInfo; onClose: () => void }) {
  const edit = useEditCluster();
  const test = useTestConnection();
  const [revealCa, setRevealCa] = useState(false);
  const ca = useClusterCa(c.name, revealCa);
  const initialConnMode: ConnMode = c.sshHost ? 'ssh' : c.proxyUrl && !c.proxyFromEnv ? 'proxy' : 'direct';
  const [connMode, setConnMode] = useState<ConnMode>(initialConnMode);
  const [form, setForm] = useState({
    server: c.server ?? '',
    skipTls: c.skipTlsVerify ?? false,
    ca: '',
    proxyUrl: c.proxyFromEnv ? '' : c.proxyUrl ?? '', // env proxies aren't in the file — don't pre-fill
    sshHost: c.sshHost ?? '',
    tlsServerName: c.tlsServerName ?? '',
    auth: 'keep' as AuthMode,
    token: '',
    cert: '',
    key: '',
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const serverValid = /^https?:\/\//i.test(form.server.trim());
  const authValid =
    form.auth === 'keep' ||
    (form.auth === 'token' ? !!form.token.trim() : !!form.cert.trim() && !!form.key.trim());
  const sshHostValid = SSH_DESTINATION_RE.test(form.sshHost.trim());
  const proxyUrlValid = PROXY_URL_RE.test(form.proxyUrl.trim());
  const dirty =
    form.server.trim() !== (c.server ?? '') ||
    form.skipTls !== (c.skipTlsVerify ?? false) ||
    connMode !== initialConnMode ||
    (connMode === 'proxy' && form.proxyUrl.trim() !== (c.proxyFromEnv ? '' : c.proxyUrl ?? '')) ||
    (connMode === 'ssh' && form.sshHost.trim() !== (c.sshHost ?? '')) ||
    form.tlsServerName.trim() !== (c.tlsServerName ?? '') ||
    form.ca.trim() !== '' ||
    form.auth !== 'keep';
  const valid = serverValid && authValid && (connMode !== 'ssh' || sshHostValid) && (connMode !== 'proxy' || proxyUrlValid);
  const busy = edit.isPending;

  const save = () => {
    const auth =
      form.auth === 'keep'
        ? ({ method: 'keep' } as const)
        : form.auth === 'token'
          ? ({ method: 'token', token: form.token.trim() } as const)
          : ({ method: 'client-cert', clientCertPem: form.cert.trim(), clientKeyPem: form.key.trim() } as const);
    edit.mutate(
      {
        ctx: c.name,
        body: {
          server: form.server.trim(),
          skipTlsVerify: form.skipTls,
          caPem: form.ca.trim() || null,
          proxyUrl: connMode === 'proxy' ? form.proxyUrl.trim() || null : null,
          sshHost: connMode === 'ssh' ? form.sshHost.trim() || null : null,
          tlsServerName: form.tlsServerName.trim() || null,
          auth,
        },
      },
      {
        // After saving, server/proxy/tls now match `c`; clear the transient
        // credential/CA fields so the form reads "clean" and Save disables.
        onSuccess: () => {
          setForm((f) => ({ ...f, ca: '', auth: 'keep', token: '', cert: '', key: '' }));
          setRevealCa(false);
          test.reset();
        },
      },
    );
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit cluster — {c.name}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <TextField
          label="API server"
          size="small"
          value={form.server}
          onChange={(e) => set('server', e.target.value)}
          placeholder="https://1.2.3.4:6443"
          error={!!form.server && !serverValid}
          helperText="The address Kubus connects to"
        />
        <FormControlLabel
          control={<Checkbox size="small" checked={form.skipTls} onChange={(e) => set('skipTls', e.target.checked)} />}
          label="Skip TLS verification (insecure)"
        />
        {!form.skipTls && (
          <Stack spacing={0.5}>
            <TextField
              label={c.caPresent ? 'Replace CA certificate (PEM)' : 'CA certificate (PEM)'}
              multiline
              minRows={3}
              value={form.ca}
              onChange={(e) => set('ca', e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              helperText={
                c.caPresent
                  ? 'Leave blank to keep the current CA certificate — PEM or base64 kubeconfig data both work'
                  : 'Optional — paste a CA certificate to verify the server (PEM or base64 kubeconfig data)'
              }
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
            />
            {c.caPresent && !revealCa && (
              <Link component="button" type="button" variant="caption" onClick={() => setRevealCa(true)} sx={{ alignSelf: 'flex-start' }}>
                Show current CA certificate
              </Link>
            )}
            {c.caPresent && revealCa && (
              <Box>
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography variant="caption" color="text.secondary">
                    Current CA certificate
                  </Typography>
                  <Box>
                    <Button size="small" onClick={() => navigator.clipboard?.writeText(ca.data?.pem ?? '')} disabled={!ca.data?.pem}>
                      Copy
                    </Button>
                    <Button size="small" onClick={() => setRevealCa(false)}>
                      Hide
                    </Button>
                  </Box>
                </Stack>
                {ca.isLoading ? (
                  <CircularProgress size={16} />
                ) : (
                  <TextField
                    value={ca.data?.pem ?? '(unable to read CA)'}
                    multiline
                    maxRows={8}
                    fullWidth
                    size="small"
                    slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 11 } } }}
                  />
                )}
              </Box>
            )}
          </Stack>
        )}

        <Divider textAlign="left" sx={{ '&::before': { width: 0 } }}>
          <Typography variant="caption" color="text.secondary">
            Authentication
          </Typography>
        </Divider>
        <FormControl size="small">
          <InputLabel id="edit-auth">Credentials</InputLabel>
          <Select labelId="edit-auth" label="Credentials" value={form.auth} onChange={(e) => set('auth', e.target.value as AuthMode)}>
            <MenuItem value="keep">Keep current ({AUTH_LABEL[c.authType ?? 'none']})</MenuItem>
            <MenuItem value="token">Replace with bearer token</MenuItem>
            <MenuItem value="client-cert">Replace with client certificate</MenuItem>
          </Select>
        </FormControl>
        {form.auth === 'token' && <TextField label="Token" size="small" value={form.token} onChange={(e) => set('token', e.target.value)} />}
        {form.auth === 'client-cert' && (
          <>
            <TextField
              label="Client certificate (PEM)"
              multiline
              minRows={3}
              value={form.cert}
              onChange={(e) => set('cert', e.target.value)}
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
            />
            <TextField
              label="Client key (PEM)"
              multiline
              minRows={3}
              value={form.key}
              onChange={(e) => set('key', e.target.value)}
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
            />
          </>
        )}

        <Divider textAlign="left" sx={{ '&::before': { width: 0 } }}>
          <Typography variant="caption" color="text.secondary">
            Only if this cluster isn&apos;t reachable directly
          </Typography>
        </Divider>
        <FormControl size="small">
          <InputLabel id="edit-conn">Connection</InputLabel>
          <Select labelId="edit-conn" label="Connection" value={connMode} onChange={(e) => setConnMode(e.target.value as ConnMode)}>
            <MenuItem value="direct">Direct — the API server is reachable from this machine</MenuItem>
            <MenuItem value="ssh">SSH jump host — Kubus opens the tunnel for you</MenuItem>
            <MenuItem value="proxy">Proxy URL — an existing SOCKS or HTTP proxy</MenuItem>
          </Select>
        </FormControl>
        {connMode === 'ssh' && <SshJumpHostField value={form.sshHost} onChange={(v) => set('sshHost', v)} />}
        {connMode === 'proxy' && (
          <>
            {c.proxyFromEnv && (
              <Alert severity="info" sx={{ py: 0 }}>
                A proxy is currently applied from an environment variable ({c.proxyUrl}). Saving here writes it into the kubeconfig and takes over.
              </Alert>
            )}
            <TextField
              label="Proxy"
              size="small"
              value={form.proxyUrl}
              onChange={(e) => set('proxyUrl', e.target.value)}
              placeholder="socks5://host:port"
              error={!!form.proxyUrl.trim() && !proxyUrlValid}
              helperText="Send this cluster's traffic through an already-running proxy"
              slotProps={{
                input: {
                  endAdornment: helpTip(
                    'Use when you already have a proxy, e.g. a corporate HTTP proxy or a manually started `ssh -D 1080 bastion` (then enter socks5://localhost:1080). To have Kubus manage the SSH tunnel itself, pick "SSH jump host" instead.',
                  ),
                },
              }}
            />
          </>
        )}
        <TextField
          label="Certificate hostname"
          size="small"
          value={form.tlsServerName}
          onChange={(e) => set('tlsServerName', e.target.value)}
          placeholder="api.example.com"
          helperText="Hostname to expect on the server's TLS certificate"
          slotProps={{
            input: {
              endAdornment: helpTip(
                'Set this only when the API server address is an IP or tunnel that does not match its certificate. Example: server is https://10.0.0.5:6443 but the certificate is issued for api.prod.example.com → enter api.prod.example.com',
              ),
            },
          }}
        />

        {edit.isError && <Alert severity="error">{(edit.error as Error).message}</Alert>}
        {edit.isSuccess && !busy && (
          <Alert severity="success">Saved. {test.data ? '' : 'Use Test connection to verify.'}</Alert>
        )}
        {test.data?.health === 'connected' && <Alert severity="success">Connected{test.data.kubernetesVersion ? ` · ${test.data.kubernetesVersion}` : ''}</Alert>}
        {test.data?.health === 'error' && <Alert severity="error">{test.data.healthMessage ?? 'Connection failed'}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          onClick={() => test.mutate(c.name)}
          disabled={test.isPending}
          startIcon={test.isPending ? <CircularProgress size={14} /> : undefined}
        >
          Test connection
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button variant="contained" onClick={save} disabled={!valid || !dirty || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
