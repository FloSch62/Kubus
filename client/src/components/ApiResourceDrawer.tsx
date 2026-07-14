import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import SchemaOutlinedIcon from '@mui/icons-material/SchemaOutlined';
import { gvkLabel, pluralLabel, type ResourceKindInfo } from '@kubus/shared';
import { useResourceSchema } from '../api/queries.js';
import { OpenApiSchemaDetail } from './detail/CrdDetail.js';

interface Props {
  open: boolean;
  ctx?: string;
  resource: ResourceKindInfo;
  onClose: () => void;
  onOpenCrd?: () => void;
}

export function ApiResourceDrawer({ open, ctx, resource, onClose, onOpenCrd }: Props) {
  const [tab, setTab] = useState('overview');
  const resourceKey = `${resource.group}/${resource.version}/${resource.plural}`;
  useEffect(() => setTab('overview'), [resourceKey]);

  const schemaRef = open && ctx ? { ctx, group: resource.group, version: resource.version, kind: resource.kind } : undefined;
  const schema = useResourceSchema(schemaRef);
  const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        backdrop: { invisible: true },
        paper: { sx: { top: '52px', height: 'calc(100% - 52px)', width: 'min(760px, 86vw)', maxWidth: '100vw' } },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Stack direction="row" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              {ctx ? `${ctx} · ` : ''}API Resource
            </Typography>
            <Typography variant="subtitle1" noWrap sx={{ fontWeight: 650, lineHeight: 1.3 }}>
              {pluralLabel(resource.kind)}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={onClose} aria-label="Close API resource">
            <CloseIcon />
          </IconButton>
        </Stack>

        <Tabs value={tab} onChange={(_event, value) => setTab(value as string)} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}>
          <Tab value="overview" label="Overview" sx={{ minHeight: 36 }} />
          <Tab value="schema" label="Schema" sx={{ minHeight: 36 }} />
        </Tabs>

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {tab === 'overview' && (
            <Stack spacing={2} sx={{ p: 2 }}>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  Definition
                </Typography>
                <Table size="small">
                  <TableBody>
                    <InfoRow label="GVK" value={gvkLabel(resource)} />
                    <InfoRow label="API version" value={apiVersion} />
                    <InfoRow label="Group" value={resource.group || 'core'} />
                    <InfoRow label="Version" value={resource.version} />
                    <InfoRow label="Kind" value={resource.kind} />
                    <InfoRow label="Plural" value={resource.plural} />
                    <InfoRow label="Scope" value={resource.namespaced ? 'Namespaced' : 'Cluster'} />
                    <InfoRow label="Short names" value={resource.shortNames?.join(', ')} />
                    <InfoRow label="Categories" value={resource.categories?.join(', ')} />
                  </TableBody>
                </Table>
              </Box>

              {resource.verbs.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                    Supported operations
                  </Typography>
                  <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap' }}>
                    {resource.verbs.map((verb) => <Chip key={verb} label={verb} size="small" variant="outlined" />)}
                  </Stack>
                </Box>
              )}

              {onOpenCrd && (
                <>
                  <Divider />
                  <Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      This API resource is backed by a CustomResourceDefinition.
                    </Typography>
                    <Button variant="outlined" startIcon={<SchemaOutlinedIcon />} onClick={onOpenCrd}>
                      Open backing CRD
                    </Button>
                  </Box>
                </>
              )}
            </Stack>
          )}

          {tab === 'schema' && (
            <>
              {!ctx && <Alert severity="info" sx={{ m: 2 }}>Select a cluster to load its OpenAPI schema.</Alert>}
              {ctx && schema.isFetching && (
                <Box sx={{ display: 'grid', placeItems: 'center', p: 4 }}>
                  <CircularProgress size={28} />
                </Box>
              )}
              {ctx && schema.error && (
                <Alert severity="info" sx={{ m: 2 }}>
                  {schema.error instanceof Error ? schema.error.message : 'The OpenAPI schema is unavailable.'}
                </Alert>
              )}
              {schema.data && <OpenApiSchemaDetail document={schema.data} />}
            </>
          )}
        </Box>
      </Box>
    </Drawer>
  );
}

function InfoRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <TableRow>
      <TableCell sx={{ width: 140, color: 'text.secondary', border: 0 }}>{label}</TableCell>
      <TableCell sx={{ border: 0, wordBreak: 'break-all' }}>{value}</TableCell>
    </TableRow>
  );
}
