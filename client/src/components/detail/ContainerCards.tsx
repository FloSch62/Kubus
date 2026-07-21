import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { AgeCell } from '../AgeCell.js';
import { StatusChip } from '../StatusChip.js';
import { UsageMeter } from '../UsageMeter.js';
import { formatBytes, formatCpu } from '../format.js';
import type { ContainerResources } from '../../kube-display.js';
import { statusTextColor } from '../../theme.js';

export interface ContainerCardData {
  name: string;
  image?: string;
  /** undefined = regular app container. */
  kind?: 'init' | 'sidecar';
  /** StatusChip label, e.g. Running / Completed / CrashLoopBackOff. */
  state?: string;
  /** Why the container is in `state` (waiting/terminated message). */
  stateMessage?: string;
  restarts?: number;
  lastRestart?: { reason?: string; at?: string };
  ports?: Array<{ port: number; protocol?: string; name?: string }>;
  resources: ContainerResources;
  usage?: { cpuMilli: number; memBytes: number };
  /** Pods aggregated into `usage` (workload views); scales the bar's denominator. */
  podCount?: number;
}

/** Card grid for a pod's (or workload template's) containers. */
export function ContainerCards({
  items,
  onForwardPort,
  onEditImage,
}: {
  items: ContainerCardData[];
  onForwardPort?: (port: number) => void;
  onEditImage?: (container: string) => void;
}) {
  if (!items.length) return null;
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 1.5 }}>
      {items.map((c) => (
        <ContainerCard key={`${c.kind ?? 'app'}:${c.name}`} c={c} onForwardPort={onForwardPort} onEditImage={onEditImage} />
      ))}
    </Box>
  );
}

function ContainerCard({ c, onForwardPort, onEditImage }: { c: ContainerCardData; onForwardPort?: (port: number) => void; onEditImage?: (container: string) => void }) {
  const showRestarts = (c.restarts ?? 0) > 0 || c.lastRestart;
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1.5, minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap title={c.name} sx={{ minWidth: 0 }}>
          {c.name}
        </Typography>
        {c.kind && <Chip label={c.kind} sx={{ height: 16, fontSize: 10, flexShrink: 0 }} />}
        <Box sx={{ flex: 1 }} />
        {c.state && (
          <Box sx={{ flexShrink: 0 }}>
            <StatusChip status={c.state} />
          </Box>
        )}
      </Stack>
      {c.image && (
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.25, minWidth: 0, mt: 0.25 }}>
          <Typography variant="caption" color="text.secondary" noWrap title={c.image} sx={{ fontFamily: 'monospace', fontSize: 11, minWidth: 0 }}>
            {c.image}
          </Typography>
          {onEditImage && (
            <Tooltip title="Change image">
              <IconButton
                size="small"
                aria-label={`Change image of ${c.name}`}
                onClick={() => onEditImage(c.name)}
                sx={{ p: 0.25, flexShrink: 0 }}
              >
                <EditOutlinedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      )}
      {c.stateMessage && (
        <Typography
          variant="caption"
          title={c.stateMessage}
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
            color: statusTextColor('warning'),
            mt: 0.25,
          }}
        >
          {c.stateMessage}
        </Typography>
      )}
      {showRestarts && (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.25, color: statusTextColor('warning') }}>
          {`Restarts ${c.restarts ?? 0}`}
          {c.lastRestart && (
            <>
              {` · last ${c.lastRestart.reason ?? 'terminated'}`}
              {c.lastRestart.at && (
                <>
                  {' '}
                  <AgeCell timestamp={c.lastRestart.at} variant="caption" /> ago
                </>
              )}
            </>
          )}
        </Typography>
      )}
      {!!c.ports?.length && (
        <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Ports
          </Typography>
          {c.ports.map((p) => {
            const forwardable = onForwardPort && (p.protocol ?? 'TCP') === 'TCP';
            const chip = (
              <Chip
                label={`${p.port}${p.name ? ` · ${p.name}` : ''}/${p.protocol ?? 'TCP'}`}
                sx={{ height: 18, fontSize: 11 }}
                clickable={!!forwardable}
                onClick={forwardable ? () => onForwardPort(p.port) : undefined}
              />
            );
            const key = `${p.port}/${p.protocol ?? 'TCP'}`;
            return forwardable ? (
              <Tooltip key={key} title={`Forward port ${p.port}`}>
                {chip}
              </Tooltip>
            ) : (
              <span key={key}>{chip}</span>
            );
          })}
        </Stack>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 1 }}>
        <Meter
          label="CPU"
          value={c.usage?.cpuMilli}
          request={c.resources.cpuRequestMilli}
          limit={c.resources.cpuLimitMilli}
          format={formatCpu}
          podCount={c.podCount}
        />
        <Meter
          label="Memory"
          value={c.usage?.memBytes}
          request={c.resources.memRequestBytes}
          limit={c.resources.memLimitBytes}
          format={formatBytes}
          podCount={c.podCount}
        />
      </Box>
      {(c.resources.ephemeralRequestBytes !== undefined || c.resources.ephemeralLimitBytes !== undefined) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {`Ephemeral storage · req ${c.resources.ephemeralRequestBytes !== undefined ? formatBytes(c.resources.ephemeralRequestBytes) : '—'} · lim ${
            c.resources.ephemeralLimitBytes !== undefined ? formatBytes(c.resources.ephemeralLimitBytes) : '—'
          }`}
        </Typography>
      )}
    </Box>
  );
}

function Meter({
  label,
  value,
  request,
  limit,
  format,
  podCount,
}: {
  label: string;
  value?: number;
  request?: number;
  limit?: number;
  format: (v: number) => string;
  podCount?: number;
}) {
  // The bar fills against the runtime ceiling: limit when set, else request.
  const perPodMax = limit ?? request;
  const pods = podCount ?? 1;
  const max = perPodMax ? perPodMax * pods : undefined;
  const maxHint = `${limit !== undefined ? 'limit' : 'requested'}${pods > 1 ? ` (${pods} pods)` : ''}`;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      {value !== undefined ? (
        <UsageMeter value={value} max={max} format={format} maxHint={maxHint} />
      ) : (
        <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 600 }}>
          —
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
        req {request !== undefined ? format(request) : '—'} · lim {limit !== undefined ? format(limit) : '—'}
      </Typography>
    </Box>
  );
}
