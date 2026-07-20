import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { useCreateResource, useDryRunResource } from '../api/queries.js';
import { manualJobYaml } from '../manual-job.js';
import { YamlEditor } from './YamlEditor.js';

export function TriggerCronJobDialog({
  ctx,
  obj,
  onClose,
  onDone,
}: {
  ctx: string;
  obj: KubeObject;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const create = useCreateResource();
  const dryRun = useDryRunResource();
  const yamlText = useMemo(() => manualJobYaml(obj), [obj]);
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>Trigger {obj.metadata.name}</DialogTitle>
      <Typography variant="body2" color="text.secondary" sx={{ px: 3, pb: 1.5 }}>
        Review the Job generated from this CronJob's template. Edits apply to this run only.
      </Typography>
      <Box sx={{ height: '60vh', display: 'flex', flexDirection: 'column', borderTop: 1, borderColor: 'divider' }}>
        <YamlEditor
          value={yamlText}
          applyLabel="Create"
          applyUnchanged
          schema={{ ctx, group: 'batch', version: 'v1', kind: 'Job' }}
          onDryRun={(text) => dryRun.mutateAsync({ ctx, yamlBody: text })}
          onApply={async (text) => {
            const created = await create.mutateAsync({ ctx, yamlBody: text });
            onDone(`Created job ${created.metadata.name}`);
            onClose();
          }}
        />
      </Box>
    </Dialog>
  );
}
