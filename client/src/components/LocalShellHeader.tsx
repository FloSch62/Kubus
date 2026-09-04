import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useContexts, useNamespaces } from '../api/queries.js';
import { useClustersStore } from '../state/clusters.js';
import type { LocalShellTab } from '../state/dock.js';

const ALL_NAMESPACES = '\0all';

const selectSx = {
  fontSize: 12.5,
  height: 26,
  '& .MuiSelect-select': { py: 0, pl: 1, pr: '26px !important', display: 'flex', alignItems: 'center' },
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'divider' },
} as const;

/**
 * The strip above a local shell: which kubeconfig context and namespace the
 * shell's KUBECONFIG points at right now, pickers to change them, and the
 * follow toggle that keeps the tab on whatever the cluster switcher selects.
 */
export function LocalShellHeader({
  tab,
  onChangeContext,
  onToggleFollow,
}: {
  tab: LocalShellTab;
  onChangeContext: (ctx: string, namespace: string | undefined) => void;
  onToggleFollow: (follow: boolean) => void;
}) {
  const { data: contexts } = useContexts({ poll: false });
  const selected = useClustersStore((s) => s.selected);
  const { data: namespaces } = useNamespaces(useMemo(() => [tab.ctx], [tab.ctx]));
  // Selected clusters first, in switcher order, then the rest of the kubeconfig.
  const contextNames = useMemo(() => {
    const known = (contexts ?? []).map((c) => c.name);
    const ordered = [...selected.filter((name) => known.includes(name)), ...known.filter((name) => !selected.includes(name))];
    return ordered.includes(tab.ctx) ? ordered : [tab.ctx, ...ordered];
  }, [contexts, selected, tab.ctx]);
  const namespaceOptions = useMemo(() => {
    const list = namespaces ?? [];
    return tab.namespace && !list.includes(tab.namespace) ? [tab.namespace, ...list] : list;
  }, [namespaces, tab.namespace]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minHeight: 28 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, letterSpacing: 0.2 }}>
        KUBECONFIG
      </Typography>
      <Select
        size="small"
        value={tab.ctx}
        onChange={(e) => onChangeContext(String(e.target.value), undefined)}
        aria-label="Terminal context"
        sx={{ ...selectSx, maxWidth: 260 }}
        MenuProps={{ slotProps: { list: { dense: true } } }}
      >
        {contextNames.map((name) => (
          <MenuItem key={name} value={name} sx={{ fontSize: 12.5 }}>
            {name}
          </MenuItem>
        ))}
      </Select>
      <Typography variant="caption" color="text.secondary">
        namespace
      </Typography>
      <Select
        size="small"
        value={tab.namespace ?? ALL_NAMESPACES}
        onChange={(e) => onChangeContext(tab.ctx, e.target.value === ALL_NAMESPACES ? undefined : String(e.target.value))}
        aria-label="Terminal namespace"
        sx={{ ...selectSx, maxWidth: 220 }}
        MenuProps={{ slotProps: { list: { dense: true } } }}
      >
        <MenuItem value={ALL_NAMESPACES} sx={{ fontSize: 12.5 }}>
          <em>default (unset)</em>
        </MenuItem>
        {namespaceOptions.map((ns) => (
          <MenuItem key={ns} value={ns} sx={{ fontSize: 12.5 }}>
            {ns}
          </MenuItem>
        ))}
      </Select>
      <Tooltip title={tab.follow ? 'Following the cluster switcher and namespace filter. Click to pin this terminal to its current context.' : 'Pinned to this context. Click to follow the cluster switcher and namespace filter.'}>
        <IconButton size="small" aria-label={tab.follow ? 'Stop following the selection' : 'Follow the selection'} aria-pressed={!!tab.follow} onClick={() => onToggleFollow(!tab.follow)} color={tab.follow ? 'primary' : 'default'}>
          {tab.follow ? <LinkIcon sx={{ fontSize: 17 }} /> : <LinkOffIcon sx={{ fontSize: 17 }} />}
        </IconButton>
      </Tooltip>
      {tab.pty === false && (
        <Tooltip title="No pseudo-terminal could be allocated on this machine: line editing and full-screen programs will not work. Install node-pty next to the server for a full terminal.">
          <Chip size="small" color="warning" variant="outlined" label="no tty" sx={{ height: 20, fontSize: 11 }} />
        </Tooltip>
      )}
    </Box>
  );
}
