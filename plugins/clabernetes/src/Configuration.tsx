import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { helmReleaseFor } from '@kubus/plugin-sdk';
import { client } from './bridge.js';
import { Facts, ResourceButton } from './components.js';
import { key, object, ref, string, yaml, type Located } from './model.js';
import { records } from './runtime.js';

export function HelmButton({ resource }: { resource: Located }) {
  const [error, setError] = useState('');
  const release = helmReleaseFor(resource.metadata);
  return release ? (
    <>
      <Button
        endIcon={<OpenInNewIcon />}
        onClick={() => {
          setError('');
          void client.openHelmRelease(ref(resource)).catch((e: Error) => setError(e.message));
        }}
      >
        Helm release · {release.name}
      </Button>
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}
    </>
  ) : null;
}
export function ConfigCard({ config }: { config: Located }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Global Config · {config.metadata.namespace}/{config.metadata.name}
        </Typography>
        <ResourceButton resource={config}>Inspect / edit</ResourceButton>
      </Stack>
      <Facts
        values={[
          ['Cluster', config.ctx],
          ['Pull policy', string(object(config.spec?.imagePull).policy, 'Not declared')],
          [
            'Pull secrets',
            Array.isArray(object(config.spec?.imagePull).pullSecrets)
              ? (object(config.spec?.imagePull).pullSecrets as string[]).join(', ') || 'None'
              : 'Not declared',
          ],
          ['Resources', JSON.stringify(object(config.spec?.deployment).resourcesDefault ?? {})],
          ['Image placement', `${Object.keys(object(object(config.spec?.deployment).nodeSelectorsByImage)).length} image rule(s)`],
        ]}
      />
      <Box component="details" sx={{ mt: 1.5 }}>
        <summary>Declared configuration</summary>
        <Box component="pre" sx={{ mt: 1 }}>
          {yaml(config)}
        </Box>
      </Box>
    </Paper>
  );
}
export function InstallationDetails({
  configs,
  deployments,
  bootstrap,
}: {
  configs: Located[];
  deployments: Located[];
  bootstrap: Located[];
}) {
  const managers = deployments.filter((d) => d.metadata.labels?.['c9s.run/component'] === 'manager');
  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary">
        Helm configures the manager and bootstrap ConfigMap. The c9s Config supplies global defaults; each Node’s NodeProfile can override
        supported workload policies.
      </Typography>
      {managers.map((d) => {
        const labels = d.metadata.labels ?? {};
        const containers = records(object(object(d.spec?.template).spec).containers);
        const appName = records(containers[0]?.env).find((e) => e.name === 'APP_NAME')?.value ?? labels['c9s.run/app'];
        const maps = bootstrap.filter(
          (m) => m.ctx === d.ctx && m.metadata.namespace === d.metadata.namespace && m.metadata.name === `${string(appName, '')}-config`,
        );
        const global = configs.filter(
          (c) => c.ctx === d.ctx && c.metadata.namespace === d.metadata.namespace && c.metadata.name === 'clabernetes',
        );
        return (
          <Paper key={key(d)} variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
                {d.ctx} / {d.metadata.namespace}
              </Typography>
              <HelmButton resource={d} />
              <ResourceButton resource={d}>Manager Deployment</ResourceButton>
            </Stack>
            <Facts
              values={[
                ['Chart', labels['helm.sh/chart'] ?? labels.chart ?? 'Not recorded'],
                ['Revision', labels.revision ?? 'Not recorded'],
                ['Manager image', containers.map((c) => string(c.image)).join(', ')],
                ['Replicas', `${string(d.status?.readyReplicas, '0')} / ${string(d.spec?.replicas, '1')} ready`],
              ]}
            />
            {maps.map((m) => {
              const data = object(m.data);
              const mode = string(data.mergeMode, 'merge');
              return (
                <Box key={key(m)} sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                  <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                    <Typography variant="subtitle2">Chart bootstrap</Typography>
                    <Chip label={mode} variant="outlined" />
                    <ResourceButton resource={m}>{m.metadata.name}</ResourceButton>
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {mode === 'overwrite'
                      ? 'On bootstrap, chart settings replace the existing global Config.'
                      : mode === 'merge'
                        ? 'On bootstrap, chart settings fill absent values and preserve values already set in the global Config.'
                        : 'Unrecognized merge mode; inspect the bootstrap ConfigMap.'}
                  </Typography>
                  <Facts
                    values={[
                      ['Chart pull policy', string(data.imagePullPolicy)],
                      [
                        'Config pull policy',
                        global.length === 1 ? string(object(global[0]!.spec?.imagePull).policy) : 'Config not visible',
                      ],
                    ]}
                  />
                </Box>
              );
            })}
            {!maps.length && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Bootstrap ConfigMap not visible; it may be disabled in Helm or excluded by permissions.
              </Typography>
            )}
            {global.map((c) => (
              <ResourceButton key={key(c)} resource={c}>
                Global Config · {c.metadata.name}
              </ResourceButton>
            ))}
            {!helmReleaseFor(d.metadata) && (
              <Typography variant="caption" color="text.secondary">
                No Helm ownership metadata recorded on this Deployment.
              </Typography>
            )}
          </Paper>
        );
      })}
      {!managers.length && (
        <Alert severity="info">Include the c9s installation namespace to inspect its Helm chart, manager and bootstrap settings.</Alert>
      )}
      {configs.map((c) => (
        <ConfigCard key={key(c)} config={c} />
      ))}
    </Stack>
  );
}
