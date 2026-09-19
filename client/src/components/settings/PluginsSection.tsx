import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import { usePluginMutation, usePlugins } from '../../plugins/queries.js';

export function PluginsSection() {
  const plugins = usePlugins();
  const mutation = usePluginMutation();
  const [path, setPath] = useState('');
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Plugins
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Add dedicated workspaces to Kubus. Enabled plugins appear below Diff in the sidebar.
        </Typography>
      </Box>
      <Alert severity="info">
        Plugins run in isolated pages. Review their resource access before enabling them. Kubernetes permissions still apply.
      </Alert>
      {plugins.isPending && <CircularProgress size={22} />}
      {(plugins.error || mutation.error) && <Alert severity="error">{(mutation.error ?? plugins.error)?.message}</Alert>}
      {plugins.data?.map(({ manifest, bundled, enabled }) => (
        <Paper key={manifest.id} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
            <ExtensionOutlinedIcon color="primary" />
            <Typography sx={{ flex: 1, fontWeight: 600 }}>{manifest.name}</Typography>
            <Chip size="small" label={bundled ? 'Shipped with Kubus' : 'Local'} />
            <FormControlLabel
              sx={{ mr: 0 }}
              label={enabled ? 'Enabled' : 'Disabled'}
              control={
                <Switch
                  checked={enabled}
                  disabled={mutation.isPending}
                  slotProps={{ input: { 'aria-label': `Enable ${manifest.name}` } }}
                  onChange={(_, next) => mutation.mutate({ id: manifest.id, enabled: next })}
                />
              }
            />
          </Stack>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {manifest.description}
          </Typography>
          {manifest.permissions.actions.includes('pod.terminal') && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
              Enabling grants Pod shell access in Kubus.
            </Typography>
          )}
          {manifest.permissions.actions.includes('pod.interfaces') && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
              Live interface inspection runs the fixed read-only command “ip -j link show” in application containers and requires Kubernetes
              Pod exec permission.
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            v{manifest.version} · {manifest.author} · Plugin API {manifest.apiVersion}
          </Typography>
          <Box component="details" sx={{ mt: 1.5, typography: 'body2' }}>
            <summary>Permissions · {manifest.permissions.resources.reduce((n, r) => n + r.resources.length, 0)} resource types</summary>
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {manifest.permissions.resources.map((r) => (
                <Typography key={r.group} variant="caption">
                  Read {r.group || 'core'}: {r.resources.join(', ')}
                </Typography>
              ))}
              <Typography variant="caption">
                Host actions: {manifest.permissions.actions.join(', ') || 'none'}. Enabling grants these actions. Shells and logs open in
                the Kubus dock.
              </Typography>
            </Stack>
          </Box>
          {!bundled && (
            <Button
              size="small"
              color="error"
              sx={{ mt: 1 }}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ id: manifest.id, remove: true })}
            >
              Remove plugin
            </Button>
          )}
        </Paper>
      ))}
      <Typography variant="subtitle2">Install a local plugin</Typography>
      <Typography variant="body2" color="text.secondary">
        Select a built bundle directory on the machine running Kubus. It must contain kubus-plugin.json and index.html. Kubus copies the
        bundle; review its permissions and enable it above.
      </Typography>
      <Stack direction="row" spacing={1}>
        <TextField
          fullWidth
          size="small"
          label="Plugin directory"
          placeholder="/path/to/my-plugin/dist"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <Button
          variant="outlined"
          disabled={!path.trim() || mutation.isPending}
          onClick={() => mutation.mutate({ path: path.trim() }, { onSuccess: () => setPath('') })}
        >
          Install
        </Button>
      </Stack>
    </Stack>
  );
}
