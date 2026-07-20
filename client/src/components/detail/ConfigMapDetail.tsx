import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { KubeObject } from '@kubus/shared';
import { formatBytes } from '../format.js';
import { GenericDetail } from './GenericDetail.js';
import { b64ByteLength } from './data-editor.js';

function stringEntries(obj: KubeObject, field: 'data' | 'binaryData'): Array<[string, string]> {
  const map = obj[field] as Record<string, unknown> | undefined;
  return Object.entries(map ?? {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string');
}

export function ConfigMapDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const textKeys = stringEntries(obj, 'data');
  const binaryKeys = stringEntries(obj, 'binaryData');
  const total = textKeys.length + binaryKeys.length;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ px: 2, pt: 2, flexWrap: 'wrap' }}>
        <Chip label={`${total} key${total === 1 ? '' : 's'}`} variant="outlined" />
        {obj.immutable === true && <Chip label="immutable" variant="outlined" color="warning" />}
      </Stack>
      {total > 0 && (
        <Box sx={{ px: 2, pt: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Data keys
          </Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {textKeys.map(([k, v]) => (
              <Chip key={k} label={`${k} · ${formatBytes(new TextEncoder().encode(v).length)}`} variant="outlined" title={k} />
            ))}
            {binaryKeys.map(([k, v]) => (
              <Chip key={k} label={`${k} · binary ${formatBytes(b64ByteLength(v))}`} variant="outlined" title={k} />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            View and edit values per key in the Data tab.
          </Typography>
        </Box>
      )}
      <GenericDetail obj={obj} ctx={ctx} />
    </Box>
  );
}
