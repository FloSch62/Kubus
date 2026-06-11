import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CircleIcon from '@mui/icons-material/Circle';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import ShieldIcon from '@mui/icons-material/Shield';
import { useConnectContext, useContexts } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';

const HEALTH_COLOR: Record<string, 'success' | 'error' | 'warning' | 'disabled'> = {
  connected: 'success',
  error: 'error',
  connecting: 'warning',
  unknown: 'disabled',
};

export function ClusterSwitcher() {
  const { data: contexts } = useContexts();
  const connect = useConnectContext();
  const selected = useClustersStore((s) => s.selected);
  const toggleContext = useClustersStore((s) => s.toggleContext);
  const setSelected = useClustersStore((s) => s.setSelected);
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const setContextSetting = useClustersStore((s) => s.setContextSetting);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  // Reconnect persisted selections on startup; drop ones gone from kubeconfig.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !contexts) return;
    restored.current = true;
    const valid = new Set(contexts.map((c) => c.name));
    const keep = selected.filter((name) => valid.has(name));
    if (keep.length !== selected.length) setSelected(keep);
    const current = contexts.find((c) => c.current);
    const startupSelection = keep.length > 0 ? keep : current ? [current.name] : [];
    if (keep.length === 0 && startupSelection.length > 0) setSelected(startupSelection);
    for (const name of startupSelection) {
      const info = contexts.find((c) => c.name === name);
      if (info && !info.active) connect.mutate({ ctx: name, connect: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contexts]);

  const handleToggle = (name: string) => {
    const isSelected = selected.includes(name);
    toggleContext(name);
    connect.mutate({ ctx: name, connect: !isSelected });
  };

  const only = selected.length === 1 ? selected[0] : undefined;
  const label = selected.length === 0 ? 'Select clusters' : (only ?? `${selected.length} clusters`);
  const onlyProtected = only ? !!contextSettings[only]?.protected : false;

  return (
    <>
      <Button variant="outlined" color="inherit" endIcon={<KeyboardArrowDownIcon />} onClick={(e) => setAnchor(e.currentTarget)}>
        {selected.length > 0 && <CircleIcon color="success" sx={{ fontSize: 10, mr: 1 }} />}
        {label}
        {onlyProtected && <ShieldIcon sx={{ fontSize: 14, ml: 0.75, opacity: 0.7 }} />}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { minWidth: 340 } } }}>
        {(contexts ?? []).map((c) => {
          const isProtected = !!contextSettings[c.name]?.protected;
          return (
            <MenuItem key={c.name} onClick={() => handleToggle(c.name)} dense>
              <Checkbox checked={selected.includes(c.name)} size="small" sx={{ p: 0.5, mr: 1 }} />
              <ListItemIcon sx={{ minWidth: 28 }}>
                {connect.isPending && connect.variables?.ctx === c.name ? (
                  <CircularProgress size={12} />
                ) : (
                  <Tooltip title={c.healthMessage ?? c.health}>
                    <CircleIcon color={HEALTH_COLOR[c.health] ?? 'disabled'} sx={{ fontSize: 12 }} />
                  </Tooltip>
                )}
              </ListItemIcon>
              <ListItemText
                primary={c.name}
                secondary={
                  <Typography component="span" variant="caption" color="text.secondary">
                    {c.server ?? c.cluster}
                    {c.kubernetesVersion ? ` · ${c.kubernetesVersion}` : ''}
                  </Typography>
                }
              />
              <Tooltip title={isProtected ? 'Protected: destructive actions require typed confirmation' : 'Mark as protected (e.g. production)'}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setContextSetting(c.name, { protected: !isProtected });
                  }}
                >
                  {isProtected ? <ShieldIcon color="warning" sx={{ fontSize: 16 }} /> : <ShieldOutlinedIcon sx={{ fontSize: 16 }} />}
                </IconButton>
              </Tooltip>
            </MenuItem>
          );
        })}
        {(contexts ?? []).length === 0 && (
          <Box sx={{ px: 2, py: 1.5, maxWidth: 320 }}>
            <Typography variant="body2" color="text.secondary">
              No contexts found in kubeconfig. Check <Chip label="~/.kube/config" size="small" /> or set KUBECONFIG.
            </Typography>
          </Box>
        )}
      </Menu>
    </>
  );
}
