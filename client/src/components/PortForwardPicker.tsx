import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import type { KubeObject } from '@kubus/shared';
import { useWatchedList, type ClusterRow } from '../api/queries.js';
import { namespaceVisible, useClustersStore } from '../state/clusters.js';
import { podSummary } from '../kube-display.js';
import { PortForwardDialog } from './PortForwardDialog.js';
import { StatusChip } from './StatusChip.js';

/** More matches than this only render once the filter narrows them down. */
const MAX_SHOWN = 150;

export interface ForwardTarget {
  key: string;
  ctx: string;
  kind: 'Service' | 'Pod';
  obj: KubeObject;
  /** "80 · http, 9153 · metrics", or empty when nothing is declared. */
  ports: string;
}

interface PortSpec {
  port?: number;
  containerPort?: number;
  name?: string;
  protocol?: string;
}

function portSummary(ports: PortSpec[]): string {
  return ports
    .filter((p) => (p.protocol ?? 'TCP') === 'TCP')
    .map((p) => `${p.port ?? p.containerPort}${p.name ? ` · ${p.name}` : ''}`)
    .join(', ');
}

/** Services first (stable names), then running pods, each sorted by namespace and name. */
export function forwardTargets(services: ClusterRow[], pods: ClusterRow[]): ForwardTarget[] {
  const byName = (a: ForwardTarget, b: ForwardTarget) =>
    (a.obj.metadata.namespace ?? '').localeCompare(b.obj.metadata.namespace ?? '') || a.obj.metadata.name.localeCompare(b.obj.metadata.name);
  const svc = services
    .filter(({ obj }) => (obj.spec as { type?: string } | undefined)?.type !== 'ExternalName')
    .map<ForwardTarget>(({ ctx, obj }) => ({
      key: `${ctx}|svc|${obj.metadata.namespace}|${obj.metadata.name}`,
      ctx,
      kind: 'Service',
      obj,
      ports: portSummary((obj.spec as { ports?: PortSpec[] } | undefined)?.ports ?? []),
    }))
    .sort(byName);
  const running = pods
    .filter(({ obj }) => (obj.status as { phase?: string } | undefined)?.phase === 'Running')
    .map<ForwardTarget>(({ ctx, obj }) => ({
      key: `${ctx}|pod|${obj.metadata.namespace}|${obj.metadata.name}`,
      ctx,
      kind: 'Pod',
      obj,
      ports: portSummary(((obj.spec as { containers?: Array<{ ports?: PortSpec[] }> } | undefined)?.containers ?? []).flatMap((c) => c.ports ?? [])),
    }))
    .sort(byName);
  return [...svc, ...running];
}

function matches(target: ForwardTarget, words: string[]): boolean {
  if (!words.length) return true;
  const hay = `${target.obj.metadata.name} ${target.obj.metadata.namespace ?? ''} ${target.kind} ${target.ports} ${target.ctx}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * "Start a forward…": pick a Service or running Pod (with its declared ports
 * shown), then finish in the regular port-forward dialog.
 */
export function PortForwardPicker({ onClose }: { onClose: () => void }) {
  const selected = useClustersStore((s) => s.selected);
  const namespacesByContext = useClustersStore((s) => s.namespacesByContext);
  const services = useWatchedList(selected, '', 'v1', 'services');
  const pods = useWatchedList(selected, '', 'v1', 'pods');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [chosen, setChosen] = useState<ForwardTarget | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const multiCluster = selected.length > 1;

  const targets = useMemo(() => {
    const visible = (r: ClusterRow) => {
      const namespaces = namespacesByContext[r.ctx] ?? [];
      return namespaces.length === 0 || namespaceVisible(r.obj.metadata.namespace, namespaces);
    };
    return forwardTargets(services.rows.filter(visible), pods.rows.filter(visible));
  }, [services.rows, pods.rows, namespacesByContext]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return targets.filter((t) => matches(t, words));
  }, [targets, query]);
  const shown = filtered.slice(0, MAX_SHOWN);
  const loading = [services.status, pods.status].some((status) => Object.values(status).some((s) => s.state === 'loading'));

  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (chosen) {
    return <PortForwardDialog ctx={chosen.ctx} kind={chosen.kind} obj={chosen.obj} onClose={onClose} />;
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = shown[activeIndex];
      if (target) setChosen(target);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth slotProps={{ container: { sx: { alignItems: 'flex-start' } } }}>
      <DialogTitle sx={{ pb: 1 }}>Start a port forward</DialogTitle>
      <DialogContent sx={{ pb: 1.5 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder="Find a service or pod…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          slotProps={{
            htmlInput: { 'aria-label': 'Find a service or pod to forward' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <List ref={listRef} dense disablePadding sx={{ mt: 1, maxHeight: 420, overflow: 'auto' }}>
          {shown.map((t, idx) => {
            const firstPod = t.kind === 'Pod' && (idx === 0 || shown[idx - 1]!.kind !== 'Pod');
            const firstService = t.kind === 'Service' && idx === 0;
            const podStatus = t.kind === 'Pod' ? podSummary(t.obj).status : undefined;
            return (
              <Box component="li" key={t.key} sx={{ listStyle: 'none' }}>
                {(firstService || firstPod) && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', px: 1, pt: idx === 0 ? 0.5 : 1.25, pb: 0.5, fontWeight: 600, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                  >
                    {t.kind === 'Service' ? 'Services' : 'Running pods'}
                  </Typography>
                )}
                <ListItemButton
                  component="div"
                  data-idx={idx}
                  selected={idx === activeIndex}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => setChosen(t)}
                  sx={{ borderRadius: 1, minHeight: 36, gap: 1.25, px: 1 }}
                >
                  <Box sx={{ display: 'flex', color: 'text.secondary', '& svg': { fontSize: 17 } }}>
                    {t.kind === 'Service' ? <LanOutlinedIcon /> : <AppsOutlinedIcon />}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'baseline', gap: 1 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }}>
                      {t.obj.metadata.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 100, minWidth: 0 }}>
                      {[t.obj.metadata.namespace, multiCluster ? t.ctx : undefined].filter(Boolean).join(' · ')}
                    </Typography>
                  </Box>
                  {podStatus && podStatus !== 'Running' && <StatusChip status={podStatus} />}
                  <Typography variant="caption" color={t.ports ? 'text.primary' : 'text.secondary'} noWrap sx={{ maxWidth: 200, fontFamily: 'monospace' }}>
                    {t.ports || 'no declared ports'}
                  </Typography>
                </ListItemButton>
              </Box>
            );
          })}
          {shown.length === 0 && (
            <Typography component="li" variant="body2" color="text.secondary" sx={{ display: 'block', px: 1, py: 2 }}>
              {loading ? 'Loading services and pods…' : query ? 'Nothing matches.' : 'No services or running pods in the selected namespaces.'}
            </Typography>
          )}
        </List>
        {filtered.length > shown.length && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, pt: 1 }}>
            Showing {shown.length} of {filtered.length}. Type to narrow the list.
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
