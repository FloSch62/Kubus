import { useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import { statusTextColor } from '@kubus/ui-theme';
import { client } from './bridge.js';
import type { Snapshot } from './data.js';
import { key, ref, tone, type Located, type Condition } from './model.js';

export function Badge({ value }: { value: string }) {
  const color = ({ good: 'success', bad: 'error', pending: 'warning', neutral: 'default' } as const)[tone(value)];
  const label = value === 'notready' ? 'Not ready' : value.charAt(0).toUpperCase() + value.slice(1);
  return (
    <Chip
      label={label}
      variant="outlined"
      color={color}
      sx={{
        height: 22,
        fontSize: 11,
        borderColor: 'transparent',
        bgcolor: color === 'default' ? 'action.hover' : undefined,
        color: color === 'default' ? 'text.secondary' : statusTextColor(color),
        '& .MuiChip-label': { px: 0.8 },
      }}
    />
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Stack spacing={1} sx={{ p: 4, alignItems: 'center', textAlign: 'center', m: 'auto', maxWidth: 540 }}>
      <Inventory2OutlinedIcon sx={{ color: 'text.disabled', fontSize: 32, mb: 1 }} />
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {children && (
        <Typography component="div" variant="body2" color="text.secondary">
          {children}
        </Typography>
      )}
    </Stack>
  );
}
export function Facts({ values }: { values: Array<[string, ReactNode]> }) {
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: '105px minmax(0,1fr)',
        columnGap: 1.5,
        rowGap: 1,
        '& dt': { color: 'text.secondary', fontSize: 12 },
        '& dd': { m: 0, overflowWrap: 'anywhere', fontSize: 12 },
      }}
    >
      {values.map(([label, value]) => (
        <Box key={label} sx={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </Box>
      ))}
    </Box>
  );
}
export function Conditions({ conditions }: { conditions?: Condition[] }) {
  return conditions?.length ? (
    <Stack spacing={1}>
      {conditions.map((c) => (
        <Box key={c.type} sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Badge value={c.status} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {c.type}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {c.reason}
            {c.message ? ` · ${c.message}` : ''}
          </Typography>
        </Box>
      ))}
    </Stack>
  ) : (
    <Typography color="text.secondary" variant="body2">
      No conditions reported yet.
    </Typography>
  );
}
export function ResourceButton({
  resource,
  children = 'Inspect resource',
  icon = false,
}: {
  resource: Located;
  children?: ReactNode;
  icon?: boolean;
}) {
  const [error, setError] = useState('');
  const open = () => {
    setError('');
    void client.openResource(ref(resource)).catch((e: Error) => setError(e.message));
  };
  return (
    <>
      {icon ? (
        <Tooltip title={`Inspect ${resource.metadata.name}`}>
          <IconButton size="small" aria-label={`Inspect ${resource.metadata.name}`} onClick={open}>
            <OpenInNewIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      ) : (
        <Button size="small" endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />} onClick={open}>
          {children}
        </Button>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}
    </>
  );
}
export function Errors({ snapshot }: { snapshot: Snapshot }) {
  if (!snapshot.errors.length) return null;
  return (
    <Alert severity="warning" sx={{ py: 0, m: 1 }}>
      <Box component="details">
        <summary>
          {snapshot.errors.length} unavailable resource {snapshot.errors.length === 1 ? 'collection' : 'collections'}
        </summary>
        {snapshot.errors.map((e, i) => (
          <Typography key={i} variant="caption" component="p">
            {e.ctx} / {e.namespace ?? 'all namespaces'} / {e.plural}: {e.status === 404 ? 'Resource API not installed.' : e.message}
          </Typography>
        ))}
      </Box>
    </Alert>
  );
}
export const gridProps = {
  density: 'compact' as const,
  disableRowSelectionOnClick: true,
  pageSizeOptions: [25, 50, 100],
  initialState: { pagination: { paginationModel: { pageSize: 50 } } },
  getRowId: key,
};
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: 1, fontWeight: 650 }}>
      {children}
    </Typography>
  );
}
