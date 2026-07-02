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
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { ContextHealth, ContextInfo } from '@kubus/shared';
import { useConnectContext, useContexts, useReconnectContext } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';

const HEALTH_COLOR: Record<ContextHealth, 'success' | 'error' | 'warning' | 'disabled'> = {
  connected: 'success',
  error: 'error',
  connecting: 'warning',
  unknown: 'disabled',
};

function healthTitle(c: ContextInfo): string {
  if (c.health === 'connected') return c.kubernetesVersion ? `Connected · ${c.kubernetesVersion}` : 'Connected';
  if (c.health === 'connecting') return 'Checking connectivity';
  if (c.health === 'error') return c.healthMessage ?? 'Connection failed';
  return 'Not checked yet';
}

function selectedHealth(contexts: ContextInfo[] | undefined, selected: string[]): ContextHealth | undefined {
  if (!selected.length) return undefined;
  const byName = new Map((contexts ?? []).map((c) => [c.name, c.health]));
  const healths = selected.map((name) => byName.get(name) ?? 'unknown');
  if (healths.includes('error')) return 'error';
  if (healths.includes('connecting')) return 'connecting';
  if (healths.includes('unknown')) return 'unknown';
  return 'connected';
}

export function ClusterSwitcher() {
  const { data: contexts } = useContexts();
  const connect = useConnectContext();
  const reconnect = useReconnectContext();
  const selected = useClustersStore((s) => s.selected);
  const toggleContext = useClustersStore((s) => s.toggleContext);
  const setSelected = useClustersStore((s) => s.setSelected);
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const setContextSetting = useClustersStore((s) => s.setContextSetting);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  // On startup pick the persisted (or kubeconfig-current) selection; afterwards
  // keep the selection healthy on every context update: drop contexts gone from
  // the kubeconfig and re-establish sessions lost to a server restart or a live
  // kubeconfig change.
  const restored = useRef(false);
  const connecting = useRef(new Set<string>());
  useEffect(() => {
    if (!contexts) return;
    const valid = new Set(contexts.map((c) => c.name));
    let keep = selected.filter((name) => valid.has(name));
    if (keep.length !== selected.length) setSelected(keep);
    if (!restored.current) {
      restored.current = true;
      if (keep.length === 0) {
        const current = contexts.find((c) => c.current);
        if (current) setSelected((keep = [current.name]));
      }
    }
    for (const name of keep) {
      const info = contexts.find((c) => c.name === name);
      if (!info || info.active || connecting.current.has(name)) continue;
      connecting.current.add(name);
      connect.mutate({ ctx: name, connect: true }, { onSettled: () => connecting.current.delete(name) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contexts, selected]);

  const handleToggle = (name: string) => {
    const isSelected = selected.includes(name);
    toggleContext(name);
    connect.mutate({ ctx: name, connect: !isSelected });
  };

  const only = selected.length === 1 ? selected[0] : undefined;
  const label = selected.length === 0 ? 'Select clusters' : (only ?? `${selected.length} clusters`);
  const onlyProtected = only ? !!contextSettings[only]?.protected : false;
  const selectedConnectivity = selectedHealth(contexts, selected);

  return (
    <>
      <Button variant="outlined" color="inherit" endIcon={<KeyboardArrowDownIcon />} onClick={(e) => setAnchor(e.currentTarget)}>
        {selectedConnectivity && (
          <Tooltip title={selected.length === 1 ? `Connectivity: ${selectedConnectivity}` : `Selected clusters: ${selectedConnectivity}`}>
            <CircleIcon color={HEALTH_COLOR[selectedConnectivity]} sx={{ fontSize: 10, mr: 1 }} />
          </Tooltip>
        )}
        {label}
        {onlyProtected && <ShieldIcon sx={{ fontSize: 14, ml: 0.75, opacity: 0.7 }} />}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { minWidth: 340 } } }}>
        {(contexts ?? []).map((c) => {
          const isProtected = !!contextSettings[c.name]?.protected;
          const isReconnecting = reconnect.isPending && reconnect.variables === c.name;
          return (
            <MenuItem key={c.name} onClick={() => handleToggle(c.name)} dense>
              <Checkbox checked={selected.includes(c.name)} size="small" sx={{ p: 0.5, mr: 1 }} />
              <ListItemIcon sx={{ minWidth: 28 }}>
                {(connect.isPending && connect.variables?.ctx === c.name) || isReconnecting ? (
                  <CircularProgress size={12} />
                ) : (
                  <Tooltip title={healthTitle(c)}>
                    <CircleIcon color={HEALTH_COLOR[c.health]} sx={{ fontSize: 12 }} />
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
              {c.active && (
                <Tooltip title="Reconnect: rebuild this session with fresh credentials, discovery, and watches">
                  <IconButton
                    aria-label={`Reconnect ${c.name}`}
                    size="small"
                    disabled={isReconnecting}
                    onClick={(e) => {
                      e.stopPropagation();
                      reconnect.mutate(c.name);
                    }}
                  >
                    <RestartAltIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
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
