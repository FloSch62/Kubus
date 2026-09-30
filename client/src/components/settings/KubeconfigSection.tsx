import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import type { KubeconfigSource } from '@kubus/shared';
import { useKubeconfigSettings, useSetKubeconfig } from '../../api/queries.js';
import { SettingRow, SettingsGroup, SettingsPage } from './SettingsLayout.js';

const SOURCE_LABEL: Record<KubeconfigSource, string> = {
  'cli-flag': 'From the --kubeconfig flag',
  'settings-file': 'Set in these settings',
  env: 'From $KUBECONFIG',
  default: 'Default location',
};

const DESCRIPTION = 'Which kubeconfig files Kubus reads, and where that choice comes from.';

export function KubeconfigSection() {
  const { data, isLoading } = useKubeconfigSettings();
  const setKubeconfig = useSetKubeconfig();
  const [pathInput, setPathInput] = useState('');

  // Sync the input with the server state whenever it (re)loads.
  const override = data?.override;
  useEffect(() => {
    if (override !== undefined) setPathInput(override ?? '');
  }, [override]);

  if (isLoading || !data) {
    return (
      <SettingsPage title="Kubeconfig" description={DESCRIPTION}>
        <Skeleton variant="rounded" height={96} />
        <Skeleton variant="rounded" height={120} />
      </SettingsPage>
    );
  }

  const apply = (path: string | null) => {
    setKubeconfig.mutate({ path });
  };
  const dirty = pathInput.trim() !== (data.override ?? '');

  return (
    <SettingsPage title="Kubeconfig" description={DESCRIPTION}>
      <SettingsGroup
        title="Files in use"
        action={
          <Chip
            size="small"
            variant="outlined"
            label={`${SOURCE_LABEL[data.source]}${data.source === 'env' && data.kubeconfigEnv ? ` (${data.kubeconfigEnv})` : ''}`}
            sx={{ height: 20, fontSize: 11, maxWidth: 360 }}
          />
        }
        flush
      >
        {data.paths.map((p) => (
          <Box key={p} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 1.25, '& + &': { borderTop: 1, borderColor: 'divider' } }}>
            <InsertDriveFileOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }} />
            <Typography sx={{ fontFamily: 'monospace', fontSize: 12.5, overflowWrap: 'anywhere', minWidth: 0 }}>{p}</Typography>
          </Box>
        ))}
        {data.paths.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
            No kubeconfig path could be resolved.
          </Typography>
        )}
      </SettingsGroup>
      {data.source === 'cli-flag' && (
        <Alert severity="info" variant="outlined">
          The server was started with <code>--kubeconfig</code>. Changes here apply immediately and persist, but the flag wins again on the next launch.
        </Alert>
      )}
      <SettingsGroup title="Override">
        <SettingRow
          stacked
          label="Kubeconfig path"
          labelFor="settings-kubeconfig-path"
          description="Point Kubus at a different kubeconfig file. It persists across restarts."
        >
          <Stack direction="row" spacing={1} sx={{ mt: 1.25, alignItems: 'center' }}>
            <TextField
              id="settings-kubeconfig-path"
              fullWidth
              size="small"
              placeholder="~/.kube/other-config"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty && pathInput.trim()) apply(pathInput.trim());
              }}
              slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } }}
            />
            <Button variant="contained" disabled={!dirty || !pathInput.trim() || setKubeconfig.isPending} onClick={() => apply(pathInput.trim())}>
              Apply
            </Button>
            <Button disabled={!data.override || setKubeconfig.isPending} onClick={() => apply(null)}>
              Reset
            </Button>
          </Stack>
          {setKubeconfig.isError && (
            <Alert severity="error" sx={{ mt: 1.25 }}>
              {setKubeconfig.error instanceof Error ? setKubeconfig.error.message : String(setKubeconfig.error)}
            </Alert>
          )}
          {setKubeconfig.isSuccess && !setKubeconfig.isPending && (
            <Alert severity="success" sx={{ mt: 1.25 }}>
              Kubeconfig updated and contexts reloaded.
            </Alert>
          )}
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
