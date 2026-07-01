import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import type { KubeconfigSource } from '@kubus/shared';
import { useKubeconfigSettings, useSetKubeconfig } from '../../api/queries.js';

const SOURCE_LABEL: Record<KubeconfigSource, string> = {
  'cli-flag': 'from the --kubeconfig flag',
  'settings-file': 'set in these settings',
  env: 'from $KUBECONFIG',
  default: 'default location',
};

export function KubeconfigSection() {
  const { data, isLoading } = useKubeconfigSettings();
  const setKubeconfig = useSetKubeconfig();
  const [pathInput, setPathInput] = useState('');

  // Sync the input with the server state whenever it (re)loads.
  useEffect(() => {
    if (data) setPathInput(data.override ?? '');
  }, [data]);

  if (isLoading || !data) {
    return <CircularProgress size={20} />;
  }

  const apply = (path: string | null) => {
    setKubeconfig.mutate({ path });
  };
  const dirty = pathInput.trim() !== (data.override ?? '');

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Kubeconfig files
        </Typography>
        <Stack spacing={0.5}>
          {data.paths.map((p) => (
            <Typography key={p} sx={{ fontFamily: 'monospace', fontSize: 13 }}>
              {p}
            </Typography>
          ))}
          {data.paths.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No kubeconfig path could be resolved.
            </Typography>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {SOURCE_LABEL[data.source]}
          {data.source === 'env' && data.kubeconfigEnv ? ` (${data.kubeconfigEnv})` : ''}
        </Typography>
      </Box>
      {data.source === 'cli-flag' && (
        <Alert severity="info">
          The server was started with <code>--kubeconfig</code>. Changes here apply immediately and persist, but the flag wins again on the next launch.
        </Alert>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          fullWidth
          size="small"
          label="Override path"
          placeholder="~/.kube/other-config"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          helperText="Point kubus at a different kubeconfig file; persists across restarts"
        />
        <Button variant="contained" disabled={!dirty || !pathInput.trim() || setKubeconfig.isPending} onClick={() => apply(pathInput.trim())}>
          Apply
        </Button>
        <Button disabled={!data.override || setKubeconfig.isPending} onClick={() => apply(null)}>
          Reset
        </Button>
      </Stack>
      {setKubeconfig.isError && <Alert severity="error">{setKubeconfig.error instanceof Error ? setKubeconfig.error.message : String(setKubeconfig.error)}</Alert>}
      {setKubeconfig.isSuccess && !setKubeconfig.isPending && <Alert severity="success">Kubeconfig updated — contexts reloaded.</Alert>}
    </Stack>
  );
}
