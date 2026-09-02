import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import SubjectIcon from '@mui/icons-material/Subject';
import TerminalIcon from '@mui/icons-material/Terminal';
import type { PodEnvVar } from '@kubus/shared';
import { AgeCell } from '../AgeCell.js';
import { CopyValueButton } from '../CellCopy.js';
import { StatusChip } from '../StatusChip.js';
import { UsageMeter } from '../UsageMeter.js';
import { formatBytes, formatCpu } from '../format.js';
import type { ContainerResources } from '../../kube-display.js';
import { statusTextColor } from '../../theme.js';
import { ClampedText } from './ClampedText.js';
import { EnvTable, type EnvRefKind } from './EnvTable.js';
import { Fact, Facts } from './Facts.js';
import { CountPill } from './Section.js';
import type { MountRow, ProbeRow, VolumeRefKind } from './container-spec.js';

export interface ContainerPanelData {
  name: string;
  image?: string;
  /** undefined = regular app container. */
  kind?: 'init' | 'sidecar';
  /** StatusChip label, e.g. Running / Completed / CrashLoopBackOff. */
  state?: string;
  /** Why the container is in `state` (waiting/terminated message). */
  stateMessage?: string;
  /** Readiness as Kubernetes reports it — a Running container can still be not ready. */
  ready?: boolean;
  /**
   * A live process exists for `onShell` to attach to. Pods derive it from the
   * container's own state; workload templates from whether any of their pods
   * currently runs this container.
   */
  shellable?: boolean;
  restarts?: number;
  lastRestart?: { reason?: string; at?: string; exitCode?: number };
  ports?: Array<{ port: number; protocol?: string; name?: string }>;
  resources: ContainerResources;
  usage?: { cpuMilli: number; memBytes: number };
  /** Pods aggregated into `usage` (workload views); scales the bar's denominator. */
  podCount?: number;
  probes: ProbeRow[];
  mounts: MountRow[];
  /** Resolved (pods) or declared (templates) environment; undefined while loading. */
  env?: PodEnvVar[];
  envLoading?: boolean;
  command?: string[];
  args?: string[];
  imagePullPolicy?: string;
  workingDir?: string;
}

export interface ContainerActions {
  /** Stream this container's logs. */
  onLogs?: (container: string) => void;
  /** Open a shell in this container (pods only — a template has no process). */
  onShell?: (container: string) => void;
  onForwardPort?: (port: number) => void;
  onEditImage?: (container: string) => void;
  /** Navigate to a ConfigMap/Secret/PVC referenced by env or mounts. */
  onOpenRef?: (kind: VolumeRefKind | EnvRefKind, name: string) => void;
  /** Secret env values are shown in clear (live pods only). */
  revealSecrets?: boolean;
  onRevealSecrets?: (reveal: boolean) => void;
}

/**
 * Full-width panels, one per container, inside a flush Section. Each panel
 * is the container's whole story: state, image, resources and ports up
 * front, with probes, environment, mounts and command a toggle away — so a
 * multi-container pod reads container by container instead of table by
 * table.
 */
export function ContainerPanels({ items, ...actions }: { items: ContainerPanelData[] } & ContainerActions) {
  if (!items.length) return null;
  return (
    <Stack divider={<Divider />}>
      {items.map((c) => (
        <ContainerPanel key={`${c.kind ?? 'app'}:${c.name}`} c={c} {...actions} />
      ))}
    </Stack>
  );
}

type DetailKey = 'probes' | 'env' | 'mounts' | 'command';

function PanelAction({ icon, label, ariaLabel, onClick }: { icon: ReactNode; label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <Button
      size="small"
      startIcon={icon}
      aria-label={ariaLabel}
      onClick={onClick}
      sx={{
        px: 0.875,
        py: 0.125,
        minWidth: 0,
        fontSize: 12,
        color: 'text.secondary',
        '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
        '& .MuiButton-startIcon': { mr: 0.5, '& svg': { fontSize: 15 } },
      }}
    >
      {label}
    </Button>
  );
}

function KindTag({ children }: { children: string }) {
  return (
    <Box
      component="span"
      sx={{
        px: 0.625,
        py: 0.125,
        borderRadius: 0.75,
        fontSize: 10.5,
        fontWeight: 600,
        lineHeight: 1.5,
        letterSpacing: 0.2,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        flexShrink: 0,
      }}
    >
      {children}
    </Box>
  );
}

function DetailToggle({ label, count, active, ariaLabel, onClick }: { label: string; count?: number; active: boolean; ariaLabel: string; onClick: () => void }) {
  return (
    <ButtonBase
      aria-expanded={active}
      aria-label={ariaLabel}
      onClick={onClick}
      sx={(t) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        pl: 0.5,
        pr: 1,
        py: 0.375,
        borderRadius: 1,
        fontSize: 12,
        fontWeight: 550,
        color: active ? 'primary.main' : 'text.secondary',
        bgcolor: active ? alpha(t.palette.primary.main, t.palette.mode === 'dark' ? 0.16 : 0.09) : 'transparent',
        '&:hover': {
          color: active ? 'primary.main' : 'text.primary',
          bgcolor: active ? alpha(t.palette.primary.main, t.palette.mode === 'dark' ? 0.22 : 0.14) : 'action.hover',
        },
      })}
    >
      <KeyboardArrowRightIcon sx={{ fontSize: 16, transform: active ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
      {label}
      {count !== undefined && <CountPill value={count} sx={{ ml: 0.25, ...(active && { bgcolor: 'transparent', color: 'inherit', px: 0, minWidth: 0 }) }} />}
    </ButtonBase>
  );
}

function ContainerPanel({
  c,
  onLogs,
  onShell,
  onForwardPort,
  onEditImage,
  onOpenRef,
  revealSecrets,
  onRevealSecrets,
}: { c: ContainerPanelData } & ContainerActions) {
  const [detail, setDetail] = useState<DetailKey>();
  // exec needs a live process, so only a running container gets a shell —
  // a crashlooping one still gets logs, which is where its output is.
  const shellable = onShell && c.shellable;
  const restarts = c.restarts ?? 0;
  const notReady = c.ready === false && c.state === 'Running';
  const hasCommand = !!(c.command?.length || c.args?.length);
  const details: Array<{ key: DetailKey; label: string; count?: number }> = [];
  if (c.probes.length) details.push({ key: 'probes', label: 'Probes', count: c.probes.length });
  if (c.envLoading || (c.env?.length ?? 0) > 0) details.push({ key: 'env', label: 'Environment', count: c.env?.length });
  if (c.mounts.length) details.push({ key: 'mounts', label: 'Mounts', count: c.mounts.length });
  if (hasCommand) details.push({ key: 'command', label: 'Command' });
  const open = details.some((d) => d.key === detail) ? detail : undefined;

  return (
    <Box sx={{ px: 1.5, py: 1.25, minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.75, minWidth: 0, flex: '1 1 160px' }}>
          <Typography variant="subtitle2" noWrap title={c.name} sx={{ minWidth: 0, fontSize: 13.5 }}>
            {c.name}
          </Typography>
          {c.kind && <KindTag>{c.kind}</KindTag>}
          {c.state && (
            <Box sx={{ flexShrink: 0 }}>
              <StatusChip status={c.state} />
            </Box>
          )}
          {notReady && (
            <Typography variant="caption" sx={{ color: statusTextColor('warning'), fontWeight: 550, flexShrink: 0 }}>
              not ready
            </Typography>
          )}
        </Stack>
        {(onLogs || shellable) && (
          <Stack direction="row" sx={{ gap: 0.25, flexShrink: 0, ml: 'auto', mr: -0.5 }}>
            {onLogs && <PanelAction icon={<SubjectIcon />} label="Logs" ariaLabel={`Logs for container ${c.name}`} onClick={() => onLogs(c.name)} />}
            {shellable && <PanelAction icon={<TerminalIcon />} label="Shell" ariaLabel={`Shell into container ${c.name}`} onClick={() => onShell(c.name)} />}
          </Stack>
        )}
      </Stack>
      {c.image && (
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.25, minWidth: 0, mt: 0.25 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 11.5, minWidth: 0, wordBreak: 'break-all' }}>
            {c.image}
          </Typography>
          <CopyValueButton text={c.image} label={`Copy image of ${c.name}`} />
          {onEditImage && (
            <Tooltip title="Change image">
              <IconButton size="small" aria-label={`Change image of ${c.name}`} onClick={() => onEditImage(c.name)} sx={{ p: 0.25, flexShrink: 0 }}>
                <EditOutlinedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      )}
      {c.stateMessage && <ClampedText text={c.stateMessage} lines={3} sx={{ mt: 0.5, fontSize: 12, color: statusTextColor('warning') }} />}
      {(restarts > 0 || c.lastRestart) && (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: statusTextColor('warning') }}>
          {`${restarts} restart${restarts === 1 ? '' : 's'}`}
          {c.lastRestart && (
            <>
              {` · last ${c.lastRestart.reason ?? 'terminated'}`}
              {c.lastRestart.exitCode !== undefined && c.lastRestart.exitCode !== 0 && ` (exit ${c.lastRestart.exitCode})`}
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
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', columnGap: 2.5, rowGap: 1, mt: 1.25 }}>
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
      {!!c.ports?.length && (
        <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25 }}>
            Ports
          </Typography>
          {c.ports.map((p) => {
            const forwardable = onForwardPort && (p.protocol ?? 'TCP') === 'TCP';
            const chip = (
              <Chip
                label={`${p.port}${p.name ? ` · ${p.name}` : ''}/${p.protocol ?? 'TCP'}`}
                sx={{ height: 20, fontSize: 11.5 }}
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
      {details.length > 0 && (
        <Stack direction="row" sx={{ gap: 0.5, mt: 1, flexWrap: 'wrap', ml: -0.5 }}>
          {details.map((d) => (
            <DetailToggle
              key={d.key}
              label={d.label}
              count={d.count}
              active={open === d.key}
              ariaLabel={`${d.label} for ${c.name}`}
              onClick={() => setDetail((v) => (v === d.key ? undefined : d.key))}
            />
          ))}
        </Stack>
      )}
      {open && (
        <Box sx={{ mt: 0.75, border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
          {open === 'probes' && <ProbeRows rows={c.probes} />}
          {open === 'env' && <EnvTable env={c.env} loading={c.envLoading} reveal={revealSecrets} onReveal={onRevealSecrets} onOpenRef={onOpenRef} />}
          {open === 'mounts' && <MountRows rows={c.mounts} onOpenRef={onOpenRef} />}
          {open === 'command' && <CommandFacts c={c} />}
        </Box>
      )}
    </Box>
  );
}

const PROBE_LABEL: Record<ProbeRow['kind'], string> = { readiness: 'Readiness', liveness: 'Liveness', startup: 'Startup' };

function ProbeRows({ rows }: { rows: ProbeRow[] }) {
  return (
    <Table size="small" sx={{ '& td': { px: 1, py: 0.625 }, '& tr:last-child td': { borderBottom: 0 } }}>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.kind}>
            <TableCell sx={{ width: '1%', whiteSpace: 'nowrap', verticalAlign: 'top', fontWeight: 550 }}>{PROBE_LABEL[r.kind]}</TableCell>
            <TableCell sx={{ verticalAlign: 'top' }}>
              <Typography component="div" sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-word' }}>
                {r.target}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {r.timing}
              </Typography>
            </TableCell>
            <TableCell align="right" sx={{ width: '1%', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
              {r.state ? <StatusChip status={r.state} /> : ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MountRows({ rows, onOpenRef }: { rows: MountRow[]; onOpenRef?: ContainerActions['onOpenRef'] }) {
  return (
    <Table size="small" sx={{ '& td': { px: 1, py: 0.625 }, '& tr:last-child td': { borderBottom: 0 } }}>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={`${m.volume}:${m.path}`}>
            <TableCell sx={{ verticalAlign: 'top', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{m.path}</TableCell>
            <TableCell sx={{ verticalAlign: 'top', width: '1%', whiteSpace: 'nowrap' }}>
              <Typography variant="body2" component="div" sx={{ fontSize: 12.5 }}>
                {m.volume}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {m.refKind && m.refName && onOpenRef ? (
                  <Link component="button" variant="caption" color="text.secondary" onClick={() => onOpenRef(m.refKind!, m.refName!)}>
                    {m.source}
                  </Link>
                ) : (
                  m.source
                )}
                {m.note && ` · ${m.note}`}
              </Typography>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CommandFacts({ c }: { c: ContainerPanelData }) {
  return (
    <Box sx={{ p: 1.25 }}>
      <Facts>
        <Fact label="Command" mono>
          {c.command?.join(' ')}
        </Fact>
        <Fact label="Args" mono>
          {c.args?.join(' ')}
        </Fact>
        <Fact label="Working dir" mono>
          {c.workingDir}
        </Fact>
        <Fact label="Pull policy">{c.imagePullPolicy}</Fact>
      </Facts>
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
      <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
          req {request !== undefined ? format(request) : '—'} · lim {limit !== undefined ? format(limit) : '—'}
        </Typography>
      </Stack>
      {value !== undefined ? (
        <UsageMeter value={value} max={max} format={format} maxHint={maxHint} placeholder />
      ) : (
        <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 600, display: 'block' }}>
          no usage data
        </Typography>
      )}
    </Box>
  );
}
