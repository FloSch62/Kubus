import { memo, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import TuneIcon from '@mui/icons-material/Tune';

export interface LogSource {
  pod: string;
  containers: string[];
  /** A pod of a fixed selection that no longer exists. */
  gone?: boolean;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

interface LogSourceSelectorProps {
  sources: readonly LogSource[];
  containerNames: readonly string[];
  enabledPods: ReadonlySet<string>;
  enabledContainers: ReadonlySet<string>;
  /** "Deployment web" when the tab follows a workload's pods. */
  following?: string;
  podNotes: ReadonlyMap<string, string>;
  /** Per-pod line colours; shown as a legend when lines carry a pod tag. */
  podColors?: ReadonlyMap<string, string>;
  /** The short tag each pod's lines carry (see shortPodLabels). */
  podLabels?: ReadonlyMap<string, string>;
  onApply: (pods: ReadonlySet<string>, containers: ReadonlySet<string>) => void;
}

export const LogSourceSelector = memo(function LogSourceSelector({
  sources,
  containerNames,
  enabledPods,
  enabledContainers,
  following,
  podNotes,
  podColors,
  podLabels,
  onApply,
}: LogSourceSelectorProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draftPods, setDraftPods] = useState<ReadonlySet<string>>(() => new Set(enabledPods));
  const [draftContainers, setDraftContainers] = useState<ReadonlySet<string>>(() => new Set(enabledContainers));
  const livePods = sources.filter((source) => !source.gone);
  const podCountByContainer = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) {
      for (const container of source.containers) {
        counts.set(container, (counts.get(container) ?? 0) + 1);
      }
    }
    return counts;
  }, [sources]);

  const openSelector = (target: HTMLElement) => {
    setDraftPods(new Set(enabledPods));
    setDraftContainers(new Set(enabledContainers));
    setAnchor(target);
  };

  const togglePod = (pod: string) => {
    setDraftPods((current) => {
      if (current.has(pod) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(pod)) next.delete(pod);
      else next.add(pod);
      return next;
    });
  };

  const toggleContainer = (container: string) => {
    setDraftContainers((current) => {
      if (current.has(container) && current.size === 1) return current;
      const next = new Set(current);
      if (next.has(container)) next.delete(container);
      else next.add(container);
      return next;
    });
  };

  const selectionChanged = !setsEqual(draftPods, enabledPods) || !setsEqual(draftContainers, enabledContainers);

  return (
    <>
      <Tooltip describeChild title={following ? `Following ${following}: new pods join as they start, terminated pods leave` : 'Pick the pods and containers to read'}>
        <Button
          size="small"
          variant="outlined"
          startIcon={
            podColors ? (
              <Box component="span" aria-hidden sx={{ display: 'inline-flex', gap: '3px' }}>
                {livePods
                  .filter((source) => enabledPods.has(source.pod))
                  .slice(0, 4)
                  .map((source) => (
                    <Box key={source.pod} component="span" sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: podColors.get(source.pod) ?? 'text.disabled' }} />
                  ))}
              </Box>
            ) : (
              <TuneIcon fontSize="small" />
            )
          }
          onClick={(event) => openSelector(event.currentTarget)}
          aria-label="Select log pods and containers"
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : undefined}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {enabledPods.size}/{livePods.length} pods · {containerNames.length ? `${enabledContainers.size}/${containerNames.length} containers` : 'all containers'}
        </Button>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { minWidth: 300, maxWidth: 520, maxHeight: 480 } } }}>
        {anchor ? (
          <>
            <ListSubheader disableSticky sx={{ lineHeight: 1.4, pt: 1, pb: 0.75 }}>
              {following ? `Pods of ${following}` : 'Pods'}
              {following ? (
                <Typography component="span" variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                  New pods join as they start
                </Typography>
              ) : null}
            </ListSubheader>
            {sources.length === 0 ? (
              <MenuItem dense disabled>
                <ListItemText primary="No pods right now" secondary="Pods join here as soon as they are created" />
              </MenuItem>
            ) : null}
            {sources.map((source) => {
              const checked = draftPods.has(source.pod);
              const note = podNotes.get(source.pod);
              const containers = source.containers.join(', ') || 'Containers discovered by server';
              return (
                <MenuItem key={source.pod} dense disabled={source.gone || (checked && draftPods.size === 1)} onClick={() => togglePod(source.pod)}>
                  <Checkbox size="small" checked={checked && !source.gone} />
                  <ListItemText
                    primary={
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                        {podColors ? (
                          <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', flexShrink: 0, bgcolor: podColors.get(source.pod) ?? 'text.disabled' }} />
                        ) : null}
                        {source.pod}
                      </Box>
                    }
                    secondary={[podLabels && podLabels.get(source.pod) !== source.pod ? `shown as ${podLabels.get(source.pod)}` : '', containers, note].filter(Boolean).join(' · ')}
                  />
                </MenuItem>
              );
            })}
            {containerNames.length ? <Divider /> : null}
            {containerNames.length ? <ListSubheader disableSticky>Containers</ListSubheader> : null}
            {containerNames.map((container) => {
              const checked = draftContainers.has(container);
              const podCount = podCountByContainer.get(container) ?? 0;
              return (
                <MenuItem key={container} dense disabled={checked && draftContainers.size === 1} onClick={() => toggleContainer(container)}>
                  <Checkbox size="small" checked={checked} />
                  <ListItemText primary={container} secondary={`Available in ${podCount} ${podCount === 1 ? 'pod' : 'pods'}`} />
                </MenuItem>
              );
            })}
            <Divider />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, px: 1.5, py: 1 }}>
              <Button size="small" onClick={() => setAnchor(null)}>
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                disabled={!selectionChanged}
                onClick={() => {
                  onApply(draftPods, draftContainers);
                  setAnchor(null);
                }}
              >
                Apply
              </Button>
            </Box>
          </>
        ) : null}
      </Menu>
    </>
  );
});
