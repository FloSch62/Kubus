import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import SailingOutlinedIcon from '@mui/icons-material/SailingOutlined';
import { useNavigate } from 'react-router';
import { useHelmOperations } from '../api/queries.js';
import { useHelmOperationsStore } from '../state/helm-operations.js';
import { HelmOperationStatus } from './HelmOperationStatus.js';

export default function HelmOperationsDrawer() {
  const open = useHelmOperationsStore((state) => state.open);
  const setOpen = useHelmOperationsStore((state) => state.setOpen);
  const operations = useHelmOperations();
  const navigate = useNavigate();

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={() => setOpen(false)}
      slotProps={{
        backdrop: { invisible: true },
        paper: { sx: { top: '52px', height: 'calc(100% - 52px)', width: 'min(560px, 92vw)', maxWidth: '100vw' } },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Stack direction="row" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}>
          <SailingOutlinedIcon sx={{ mr: 1 }} />
          <Box>
            <Typography variant="subtitle1" sx={{ lineHeight: 1.25 }}>
              Helm operations
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Operations continue while this drawer is closed
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={() => void operations.refetch()} aria-label="Refresh Helm operations" disabled={operations.isFetching}>
            <RefreshIcon />
          </IconButton>
          <IconButton onClick={() => setOpen(false)} aria-label="Close Helm operations">
            <CloseIcon />
          </IconButton>
        </Stack>

        <Stack spacing={1.25} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
          {operations.error ? <Typography color="error">{operations.error.message}</Typography> : null}
          {!operations.isLoading && !operations.data?.length ? (
            <Box sx={{ py: 8, textAlign: 'center' }}>
              <Typography variant="subtitle1">No Helm operations yet</Typography>
              <Typography variant="body2" color="text.secondary">
                Install, upgrade, and rollback progress will appear here.
              </Typography>
            </Box>
          ) : null}
          {(operations.data ?? []).map((operation) => {
            const canOpenRelease = operation.kind !== 'install' || operation.phase !== 'queued' && operation.phase !== 'resolving-chart' && operation.phase !== 'rendering';
            return (
              <Box key={operation.id}>
                <HelmOperationStatus operation={operation} showDrawerAction={false} />
                {canOpenRelease ? (
                  <Button
                    size="small"
                    sx={{ mt: 0.5, ml: 1 }}
                    onClick={() => {
                      setOpen(false);
                      void navigate(
                        `/helm/${encodeURIComponent(operation.ctx)}/${encodeURIComponent(operation.namespace)}/${encodeURIComponent(operation.releaseName)}`,
                      );
                    }}
                  >
                    Open release
                  </Button>
                ) : null}
              </Box>
            );
          })}
        </Stack>
      </Box>
    </Drawer>
  );
}
