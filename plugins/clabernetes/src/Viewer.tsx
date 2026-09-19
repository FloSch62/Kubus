import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { ViewerHandle } from '@containerlab/clab-viewer';
import '@containerlab/clab-viewer/styles.css';
import { layoutAnnotations } from './layout.js';

export function Viewer({ yaml, onSelect }: { yaml: string; onSelect: (name: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const selection = useRef(onSelect);
  selection.current = onSelect;
  const theme = useTheme();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<'auto' | 'source'>('auto');
  const [labels, setLabels] = useState(false);
  useEffect(() => {
    let disposed = false;
    let viewer: ViewerHandle | undefined;
    setError('');
    setLoading(true);
    void Promise.all([import('@containerlab/clab-viewer'), layoutAnnotations(yaml, layout)])
      .then(([{ mountViewer }, positions]) => {
        if (disposed || !container.current) return;
        viewer = mountViewer(container.current, {
          yaml,
          theme: theme.palette.mode,
          borderless: true,
          annotations: JSON.stringify({ nodeAnnotations: positions.map((node) => ({ ...node, iconColor: theme.palette.primary.main })) }),
          viewerOptions: {
            controls: true,
            transparent: false,
            background: 'dots',
            fitPadding: 0.1,
            linkLabels: labels ? 'show-all' : 'on-select',
            appearance: {
              background: theme.palette.background.default,
              foreground: theme.palette.text.primary,
              surface: theme.palette.background.paper,
              border: theme.palette.divider,
              accent: theme.palette.primary.main,
              edge: theme.palette.text.secondary,
              font: theme.typography.fontFamily,
            },
            onNodeSelect: (id) => selection.current(id),
          },
          onReady: () => {
            if (!disposed) setLoading(false);
          },
          onError: (e) => {
            if (!disposed) {
              setLoading(false);
              setError(String(e));
            }
          },
        });
      })
      .catch((e: unknown) => {
        if (!disposed) {
          setLoading(false);
          setError(String(e));
        }
      });
    return () => {
      disposed = true;
      viewer?.unmount();
    };
    // Status polling must not remount the viewer and discard the user's pan/zoom.
  }, [yaml, theme, layout, labels]);
  return (
    <Stack sx={{ flex: 1, height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 0.5, alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          Select a device to inspect its runtime
        </Typography>
        <ToggleButton size="small" value="labels" selected={labels} onChange={() => setLabels((v) => !v)} sx={{ py: 0.25, fontSize: 11 }}>
          Interfaces
        </ToggleButton>
        <Select
          value={layout}
          size="small"
          inputProps={{ 'aria-label': 'Topology layout' }}
          onChange={(e) => setLayout(e.target.value as 'auto' | 'source')}
          sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.4 } }}
        >
          <MenuItem value="auto">Auto layout</MenuItem>
          <MenuItem value="source">Source positions</MenuItem>
        </Select>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 160, position: 'relative' }}>
        <div ref={container} className="viewer" />
        {loading && <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0 }} />}
        {error && (
          <Alert severity="error" sx={{ position: 'absolute', top: 8, left: 8, right: 8 }}>
            {error}
          </Alert>
        )}
      </Box>
    </Stack>
  );
}
