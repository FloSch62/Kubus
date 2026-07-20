import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import DeleteIcon from '@mui/icons-material/Delete';
import SubjectIcon from '@mui/icons-material/Subject';
import TerminalIcon from '@mui/icons-material/Terminal';
import CableIcon from '@mui/icons-material/Cable';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ReplayIcon from '@mui/icons-material/Replay';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import LayersIcon from '@mui/icons-material/Layers';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import BlockIcon from '@mui/icons-material/Block';
import DownhillSkiingIcon from '@mui/icons-material/DownhillSkiing';
import { gvkForResource, type KubeObject, type LogTargetKind } from '@kubus/shared';
import {
  resolveLogTargetPods,
  useCordon,
  useDebugPod,
  useDeleteResource,
  useDrain,
  useRerunJob,
  useResourceList,
  useRolloutPause,
  useRolloutRestart,
  useScale,
  useSetImage,
  useStartPortForward,
  useSuspendCronJob,
  useTriggerCronJob,
} from '../api/queries.js';
import { watchClient } from '../api/ws/watch-client.js';
import { useDockStore, dockTabId, type DockTab } from '../state/dock.js';
import { useIsProtected } from '../state/clusters.js';
import { showToast } from '../state/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { FileCopyDialog } from './FileCopyDialog.js';
import { podContainerNames } from '../kube-display.js';

export interface RowActionTarget {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  obj: KubeObject;
}

export interface RowActionMenuProps {
  target: RowActionTarget;
  anchorEl?: HTMLElement | null;
  anchorPosition?: { top: number; left: number } | null;
  open: boolean;
  onClose: () => void;
}

const LOG_TARGET_KINDS = new Set<string>(['Pod', 'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Service', 'Job']);

export function isLogTargetKind(kind: string): kind is LogTargetKind {
  return LOG_TARGET_KINDS.has(kind);
}

/** Resolve a pod/workload/service to its pods and open one logs dock tab per namespace. */
async function openLogsForTarget(target: RowActionTarget, addTab: (tab: DockTab) => void): Promise<void> {
  const { ctx, kind, obj } = target;
  const actionKind = gvkForResource(target.group, target.version, target.plural)?.kind === kind ? kind : undefined;
  if (!actionKind || !isLogTargetKind(actionKind)) return;
  const name = obj.metadata.name;
  const namespace = obj.metadata.namespace;
  if (!namespace) throw new Error(`${kind} has no namespace`);
  const { pods } = await resolveLogTargetPods({ ctx, group: target.group, version: target.version, plural: target.plural, kind: actionKind, namespace, name });
  if (!pods.length) throw new Error(`No pods found for ${actionKind} ${namespace}/${name}`);
  const byNamespace = new Map<string, typeof pods>();
  for (const pod of pods) {
    const namespacePods = byNamespace.get(pod.namespace);
    if (namespacePods) namespacePods.push(pod);
    else byNamespace.set(pod.namespace, [pod]);
  }
  for (const [ns, namespacePods] of byNamespace) {
    const podNames = namespacePods.map((pod) => pod.name);
    addTab({
      kind: 'logs',
      id: dockTabId(),
      title: pods.length === 1 ? `logs: ${podNames[0] ?? name}` : `logs: ${actionKind}/${name}`,
      ctx,
      namespace: ns,
      pods: podNames,
      sources: namespacePods.map((pod) => ({ pod: pod.name, containers: pod.containers })),
      target: { kind: actionKind, name },
      follow: true,
    });
  }
}

/** Inline quick action: stream logs without opening the actions menu. Renders nothing for kinds without logs. */
export function RowLogsButton({ target }: { target: RowActionTarget }) {
  const addTab = useDockStore((s) => s.addTab);
  const [busy, setBusy] = useState(false);
  const actionKind = gvkForResource(target.group, target.version, target.plural)?.kind === target.kind ? target.kind : undefined;
  if (!actionKind || !isLogTargetKind(actionKind)) return null;
  return (
    <Tooltip title="Logs">
      <span>
        <IconButton
          size="small"
          aria-label={`Logs for ${target.obj.metadata.name}`}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setBusy(true);
            openLogsForTarget(target, addTab)
              .catch((err: unknown) => showToast('error', err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          <SubjectIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function RowActions({ target }: { target: RowActionTarget }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  // The menu wires up a dozen mutation hooks and store subscriptions, and one
  // of these cells renders per visible row — mount it only once actually
  // opened (anchor stays set through close so the fade-out still plays).
  return (
    <>
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(e.currentTarget);
          setOpen(true);
        }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      {anchor && <RowActionMenu target={target} anchorEl={anchor} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

export function RowActionMenu({ target, anchorEl, anchorPosition, open, onClose }: RowActionMenuProps) {
  const [dialog, setDialog] = useState<'delete' | 'scale' | 'forward' | 'drain' | 'restart-rs' | 'set-image' | 'debug' | 'node-shell' | 'files' | null>(null);
  const [logsBusy, setLogsBusy] = useState(false);

  const del = useDeleteResource();
  const restart = useRolloutRestart();
  const cordon = useCordon();
  const trigger = useTriggerCronJob();
  const rerun = useRerunJob();
  const rolloutPause = useRolloutPause();
  const suspendCj = useSuspendCronJob();
  const addTab = useDockStore((s) => s.addTab);

  const { kind, obj, ctx } = target;
  const actionKind = gvkForResource(target.group, target.version, target.plural)?.kind === kind ? kind : undefined;
  const name = obj.metadata.name;
  const namespace = obj.metadata.namespace;
  const isProtected = useIsProtected(ctx);
  const close = onClose;

  const ok = (text: string) => showToast('success', text);
  const fail = (err: unknown) => showToast('error', err instanceof Error ? err.message : String(err));

  const scalable = actionKind === 'Deployment' || actionKind === 'StatefulSet' || actionKind === 'ReplicaSet';
  const restartable = actionKind === 'Deployment' || actionKind === 'StatefulSet' || actionKind === 'DaemonSet';
  const isReplicaSet = actionKind === 'ReplicaSet';
  const isPod = actionKind === 'Pod';
  const isNode = actionKind === 'Node';
  const isCronJob = actionKind === 'CronJob';
  const isJob = actionKind === 'Job';
  const canForward = isPod || actionKind === 'Service';
  const canViewLogs = isLogTargetKind(actionKind ?? '');
  const unschedulable = isNode && !!(obj.spec as { unschedulable?: boolean })?.unschedulable;
  const cjSuspended = isCronJob && !!(obj.spec as { suspend?: boolean })?.suspend;
  const isDeployment = actionKind === 'Deployment';
  const rolloutPaused = isDeployment && !!(obj.spec as { paused?: boolean })?.paused;

  const openLogs = async () => {
    setLogsBusy(true);
    try {
      await openLogsForTarget(target, addTab);
    } catch (err) {
      fail(err);
    } finally {
      setLogsBusy(false);
    }
  };

  return (
    <>
      <Menu
        anchorEl={anchorEl}
        anchorPosition={anchorPosition ?? undefined}
        anchorReference={anchorPosition ? 'anchorPosition' : 'anchorEl'}
        open={open}
        onClose={close}
        onClick={(e) => e.stopPropagation()}
      >
        {canViewLogs && (
          <MenuItem
            onClick={() => {
              void openLogs();
              close();
            }}
            disabled={logsBusy}
          >
            <ListItemIcon>
              <SubjectIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Logs</ListItemText>
          </MenuItem>
        )}
        {isPod && (
          <MenuItem
            onClick={() => {
              const container = podContainerNames(obj)[0] ?? '';
              addTab({ kind: 'terminal', id: dockTabId(), title: `sh: ${name}`, ctx, namespace: namespace ?? '', pod: name, container });
              close();
            }}
          >
            <ListItemIcon>
              <TerminalIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Shell</ListItemText>
          </MenuItem>
        )}
        {isPod && (
          <MenuItem
            onClick={() => {
              setDialog('files');
              close();
            }}
          >
            <ListItemIcon>
              <FolderOpenOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Files…</ListItemText>
          </MenuItem>
        )}
        {isPod && (
          <MenuItem
            onClick={() => {
              setDialog('debug');
              close();
            }}
          >
            <ListItemIcon>
              <BugReportOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Debug container…</ListItemText>
          </MenuItem>
        )}
        {canForward && (
          <MenuItem
            onClick={() => {
              setDialog('forward');
              close();
            }}
          >
            <ListItemIcon>
              <CableIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Port forward…</ListItemText>
          </MenuItem>
        )}
        {scalable && (
          <MenuItem
            onClick={() => {
              setDialog('scale');
              close();
            }}
          >
            <ListItemIcon>
              <OpenInFullIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Scale…</ListItemText>
          </MenuItem>
        )}
        {restartable && (
          <MenuItem
            onClick={() => {
              restart.mutate(
                { ctx, body: { kind: kind as 'Deployment', namespace: namespace ?? '', name } },
                { onSuccess: () => ok(`Rollout restart triggered for ${name}`), onError: fail },
              );
              close();
            }}
          >
            <ListItemIcon>
              <RestartAltIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Rollout restart</ListItemText>
          </MenuItem>
        )}
        {isDeployment && (
          <MenuItem
            onClick={() => {
              rolloutPause.mutate(
                { ctx, body: { namespace: namespace ?? '', name, paused: !rolloutPaused } },
                { onSuccess: () => ok(`${rolloutPaused ? 'Resumed' : 'Paused'} rollout of ${name}`), onError: fail },
              );
              close();
            }}
          >
            <ListItemIcon>{rolloutPaused ? <PlayCircleOutlinedIcon fontSize="small" /> : <PauseCircleOutlinedIcon fontSize="small" />}</ListItemIcon>
            <ListItemText>{rolloutPaused ? 'Resume rollout' : 'Pause rollout'}</ListItemText>
          </MenuItem>
        )}
        {isReplicaSet && (
          <MenuItem
            onClick={() => {
              setDialog('restart-rs');
              close();
            }}
          >
            <ListItemIcon>
              <RestartAltIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Restart pods…</ListItemText>
          </MenuItem>
        )}
        {restartable && (
          <MenuItem
            onClick={() => {
              setDialog('set-image');
              close();
            }}
          >
            <ListItemIcon>
              <LayersIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Set image…</ListItemText>
          </MenuItem>
        )}
        {isJob && (
          <MenuItem
            onClick={() => {
              rerun.mutate({ ctx, body: { namespace: namespace ?? '', name } }, { onSuccess: (r) => ok(`Created job ${r.jobName}`), onError: fail });
              close();
            }}
          >
            <ListItemIcon>
              <ReplayIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Re-run</ListItemText>
          </MenuItem>
        )}
        {isCronJob && (
          <MenuItem
            onClick={() => {
              trigger.mutate({ ctx, body: { namespace: namespace ?? '', name } }, { onSuccess: (r) => ok(`Created job ${r.jobName}`), onError: fail });
              close();
            }}
          >
            <ListItemIcon>
              <PlayArrowIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Trigger now</ListItemText>
          </MenuItem>
        )}
        {isCronJob && (
          <MenuItem
            onClick={() => {
              suspendCj.mutate(
                { ctx, body: { namespace: namespace ?? '', name, suspend: !cjSuspended } },
                { onSuccess: () => ok(`${cjSuspended ? 'Resumed' : 'Suspended'} ${name}`), onError: fail },
              );
              close();
            }}
          >
            <ListItemIcon>{cjSuspended ? <PlayCircleOutlinedIcon fontSize="small" /> : <PauseCircleOutlinedIcon fontSize="small" />}</ListItemIcon>
            <ListItemText>{cjSuspended ? 'Resume' : 'Suspend'}</ListItemText>
          </MenuItem>
        )}
        {isNode && (
          <MenuItem
            onClick={() => {
              cordon.mutate(
                { ctx, body: { node: name, unschedulable: !unschedulable } },
                { onSuccess: () => ok(`${unschedulable ? 'Uncordoned' : 'Cordoned'} ${name}`), onError: fail },
              );
              close();
            }}
          >
            <ListItemIcon>
              <BlockIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{unschedulable ? 'Uncordon' : 'Cordon'}</ListItemText>
          </MenuItem>
        )}
        {isNode && (
          <MenuItem
            onClick={() => {
              setDialog('node-shell');
              close();
            }}
          >
            <ListItemIcon>
              <TerminalIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Node shell…</ListItemText>
          </MenuItem>
        )}
        {isNode && (
          <MenuItem
            onClick={() => {
              setDialog('drain');
              close();
            }}
          >
            <ListItemIcon>
              <DownhillSkiingIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Drain…</ListItemText>
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          onClick={() => {
            setDialog('delete');
            close();
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <DeleteIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText>Delete…</ListItemText>
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Delete ${kind}`}
        message={
          <>
            Delete <b>{namespace ? `${namespace}/` : ''}{name}</b> from cluster <b>{ctx}</b>? This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        confirmText={isProtected ? name : undefined}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          del.mutate(
            { ctx, group: target.group, version: target.version, plural: target.plural, name, namespace },
            {
              onSuccess: () => {
                setDialog(null);
                ok(`Deleted ${name}`);
              },
              onError: (e) => {
                setDialog(null);
                fail(e);
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={dialog === 'restart-rs'}
        title="Restart ReplicaSet pods"
        message={
          <>
            This deletes all pods of <b>{namespace ? `${namespace}/` : ''}{name}</b> at once; the ReplicaSet recreates them. Expect brief downtime.
            {(obj.metadata.ownerReferences ?? []).some((o) => o.kind === 'Deployment' && o.controller) && (
              <>
                {' '}This ReplicaSet is managed by a Deployment — consider restarting the Deployment instead for a rolling restart.
              </>
            )}
          </>
        }
        confirmLabel="Restart"
        danger
        busy={restart.isPending}
        confirmText={isProtected ? name : undefined}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          restart.mutate(
            { ctx, body: { kind: 'ReplicaSet', namespace: namespace ?? '', name } },
            {
              onSuccess: () => {
                setDialog(null);
                ok(`Restarting pods of ${name}`);
              },
              onError: (e) => {
                setDialog(null);
                fail(e);
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={dialog === 'node-shell'}
        title={`Node shell — ${name}`}
        message={
          <>
            This starts a <b>privileged pod</b> on <b>{name}</b> (host PID/network/IPC) and opens a root shell on the node via nsenter.
            The pod is deleted when the terminal closes.
          </>
        }
        confirmLabel="Open shell"
        danger
        confirmText={isProtected ? name : undefined}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          addTab({ kind: 'node-shell', id: dockTabId(), title: `node: ${name}`, ctx, node: name });
        }}
      />
      {dialog === 'scale' && <ScaleDialog target={target} onClose={() => setDialog(null)} onDone={ok} onError={fail} />}
      {dialog === 'debug' && <DebugDialog target={target} onClose={() => setDialog(null)} onDone={ok} onError={fail} />}
      {dialog === 'files' && <FileCopyDialog ctx={ctx} obj={obj} onClose={() => setDialog(null)} />}
      {dialog === 'set-image' && <SetImageDialog target={target} onClose={() => setDialog(null)} onDone={ok} onError={fail} />}
      {dialog === 'forward' && <PortForwardDialog target={target} onClose={() => setDialog(null)} onDone={ok} onError={fail} />}
      {dialog === 'drain' && <DrainDialog target={target} onClose={() => setDialog(null)} />}
    </>
  );
}

interface HpaSpec {
  scaleTargetRef?: { kind?: string; name?: string };
  minReplicas?: number;
  maxReplicas?: number;
}

function ScaleDialog({ target, onClose, onDone, onError }: { target: RowActionTarget; onClose: () => void; onDone: (t: string) => void; onError: (e: unknown) => void }) {
  const scale = useScale();
  const current = (target.obj.spec as { replicas?: number })?.replicas ?? 0;
  const [replicas, setReplicas] = useState(current);
  const isProtected = useIsProtected(target.ctx);
  const [typed, setTyped] = useState('');
  // Scaling a protected cluster's workload to zero is effectively an outage — require typed confirmation.
  const needsConfirm = isProtected && replicas === 0 && current > 0;
  const confirmBlocked = needsConfirm && typed !== target.obj.metadata.name;
  const { data: hpas } = useResourceList({
    ctx: target.ctx,
    group: 'autoscaling',
    version: 'v2',
    plural: 'horizontalpodautoscalers',
    namespace: target.obj.metadata.namespace,
  });
  const hpa = hpas?.items.find((h) => {
    const ref = (h.spec as HpaSpec)?.scaleTargetRef;
    return ref?.kind === target.kind && ref?.name === target.obj.metadata.name;
  });
  const hpaSpec = hpa?.spec as HpaSpec | undefined;
  const kedaName = hpa?.metadata.labels?.['scaledobject.keda.sh/name'];
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Scale {target.obj.metadata.name}</DialogTitle>
      <DialogContent>
        {hpa && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            HorizontalPodAutoscaler <b>{hpa.metadata.name}</b> targets this {target.kind} (min {hpaSpec?.minReplicas ?? 1} / max {hpaSpec?.maxReplicas ?? '?'})
            {kedaName ? <>, managed by KEDA ScaledObject <b>{kedaName}</b></> : null}. Manual scaling will likely be reverted by the autoscaler.
          </Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Current replicas: {current}
        </Typography>
        <TextField
          autoFocus
          fullWidth
          type="number"
          label="Replicas"
          value={replicas}
          onChange={(e) => setReplicas(Math.max(0, Number(e.target.value)))}
          slotProps={{ htmlInput: { min: 0 } }}
        />
        {needsConfirm && (
          <>
            <Typography variant="body2" sx={{ mt: 2, mb: 1 }}>
              This cluster is protected and you are scaling to <b>0</b>. Type <b>{target.obj.metadata.name}</b> to confirm.
            </Typography>
            <TextField fullWidth size="small" placeholder={target.obj.metadata.name} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={scale.isPending || confirmBlocked}
          onClick={() =>
            scale.mutate(
              {
                ctx: target.ctx,
                body: { group: target.group, version: target.version, plural: target.plural, namespace: target.obj.metadata.namespace ?? '', name: target.obj.metadata.name, replicas },
              },
              {
                onSuccess: () => {
                  onClose();
                  onDone(`Scaled ${target.obj.metadata.name} to ${replicas}`);
                },
                onError: (e) => {
                  onClose();
                  onError(e);
                },
              },
            )
          }
        >
          Scale
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface PodTemplateContainer {
  name: string;
  image?: string;
}

function SetImageDialog({ target, onClose, onDone, onError }: { target: RowActionTarget; onClose: () => void; onDone: (t: string) => void; onError: (e: unknown) => void }) {
  const setImage = useSetImage();
  const podSpec = (target.obj.spec as { template?: { spec?: { containers?: PodTemplateContainer[]; initContainers?: PodTemplateContainer[] } } })?.template?.spec;
  const containers = [
    ...(podSpec?.containers ?? []).map((c) => ({ ...c, init: false })),
    ...(podSpec?.initContainers ?? []).map((c) => ({ ...c, init: true })),
  ];
  const [selected, setSelected] = useState(containers[0]?.name ?? '');
  const chosen = containers.find((c) => c.name === selected);
  const [image, setImageValue] = useState(chosen?.image ?? '');
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Set image — {target.obj.metadata.name}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
        <FormControl size="small" fullWidth>
          <InputLabel id="set-image-container">Container</InputLabel>
          <Select
            labelId="set-image-container"
            label="Container"
            value={selected}
            onChange={(e) => {
              const name = e.target.value;
              setSelected(name);
              setImageValue(containers.find((c) => c.name === name)?.image ?? '');
            }}
          >
            {containers.map((c) => (
              <MenuItem key={`${c.init ? 'i' : 'c'}:${c.name}`} value={c.name}>
                {c.name}
                {c.init ? ' (init)' : ''}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField autoFocus fullWidth label="Image" value={image} onChange={(e) => setImageValue(e.target.value)} helperText={chosen?.image ? `Current: ${chosen.image}` : undefined} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={setImage.isPending || !image.trim() || !chosen}
          onClick={() =>
            setImage.mutate(
              {
                ctx: target.ctx,
                body: {
                  kind: target.kind as 'Deployment',
                  namespace: target.obj.metadata.namespace ?? '',
                  name: target.obj.metadata.name,
                  container: selected,
                  image: image.trim(),
                  initContainer: chosen?.init || undefined,
                },
              },
              {
                onSuccess: () => {
                  onClose();
                  onDone(`Set ${selected} image to ${image.trim()}`);
                },
                onError: (e) => {
                  onClose();
                  onError(e);
                },
              },
            )
          }
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DebugDialog({ target, onClose, onDone, onError }: { target: RowActionTarget; onClose: () => void; onDone: (t: string) => void; onError: (e: unknown) => void }) {
  const debug = useDebugPod();
  const addTab = useDockStore((s) => s.addTab);
  const containers = podContainerNames(target.obj);
  const [image, setImage] = useState('busybox:1.36');
  const [targetContainer, setTargetContainer] = useState(containers[0] ?? '');
  const name = target.obj.metadata.name;
  return (
    <Dialog open onClose={debug.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Debug container — {name}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
        <Typography variant="body2" color="text.secondary">
          Attaches an ephemeral debug container to the running pod (like <code>kubectl debug</code>) and opens a shell into it. The
          container stays in the pod spec until the pod is recreated.
        </Typography>
        <TextField autoFocus fullWidth label="Image" value={image} onChange={(e) => setImage(e.target.value)} />
        <FormControl size="small" fullWidth>
          <InputLabel id="debug-target">Target container (shared process namespace)</InputLabel>
          <Select labelId="debug-target" label="Target container (shared process namespace)" value={targetContainer} onChange={(e) => setTargetContainer(e.target.value)}>
            <MenuItem value="">None</MenuItem>
            {containers.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={debug.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={debug.isPending || !image.trim()}
          onClick={() =>
            debug.mutate(
              { ctx: target.ctx, body: { namespace: target.obj.metadata.namespace ?? '', pod: name, image: image.trim(), target: targetContainer || undefined } },
              {
                onSuccess: ({ containerName }) => {
                  onClose();
                  addTab({ kind: 'terminal', id: dockTabId(), title: `debug: ${name}`, ctx: target.ctx, namespace: target.obj.metadata.namespace ?? '', pod: name, container: containerName });
                  onDone(`Debug container ${containerName} attached`);
                },
                onError: (e) => {
                  onClose();
                  onError(e);
                },
              },
            )
          }
        >
          {debug.isPending ? 'Starting…' : 'Start'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PortForwardDialog({ target, onClose, onDone, onError }: { target: RowActionTarget; onClose: () => void; onDone: (t: string) => void; onError: (e: unknown) => void }) {
  const start = useStartPortForward();
  const isPod = target.kind === 'Pod';
  const defaultPort = isPod
    ? ((target.obj.spec as { containers?: Array<{ ports?: Array<{ containerPort: number }> }> })?.containers?.[0]?.ports?.[0]?.containerPort ?? 80)
    : ((target.obj.spec as { ports?: Array<{ port: number }> })?.ports?.[0]?.port ?? 80);
  const [remotePort, setRemotePort] = useState(defaultPort);
  const [localPort, setLocalPort] = useState<number | ''>('');
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Port forward {target.obj.metadata.name}</DialogTitle>
      <DialogContent sx={{ display: 'flex', gap: 2, pt: '12px !important' }}>
        <TextField label={`${target.kind} port`} type="number" value={remotePort} onChange={(e) => setRemotePort(Number(e.target.value))} />
        <TextField label="Local port (auto)" type="number" value={localPort} onChange={(e) => setLocalPort(e.target.value === '' ? '' : Number(e.target.value))} placeholder="auto" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={start.isPending}
          onClick={() =>
            start.mutate(
              {
                ctx: target.ctx,
                body: {
                  namespace: target.obj.metadata.namespace ?? '',
                  kind: isPod ? 'pod' : 'service',
                  name: target.obj.metadata.name,
                  remotePort,
                  localPort: localPort === '' ? undefined : localPort,
                },
              },
              {
                onSuccess: (info) => {
                  onClose();
                  onDone(`Forwarding localhost:${info.localPort} → ${info.name}:${info.remotePort}`);
                },
                onError: (e) => {
                  onClose();
                  onError(e);
                },
              },
            )
          }
        >
          Start
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DrainDialog({ target, onClose }: { target: RowActionTarget; onClose: () => void }) {
  const drain = useDrain();
  const [drainId, setDrainId] = useState<string>();
  const [progress, setProgress] = useState<{ evicted: number; total: number; current?: string; done?: boolean; error?: string }>();
  const isProtected = useIsProtected(target.ctx);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!drainId) return;
    return watchClient.onBroadcast((msg) => {
      if (msg.op === 'drain-progress' && msg.drainId === drainId) {
        setProgress(msg);
      }
    });
  }, [drainId]);

  const name = target.obj.metadata.name;
  const running = !!drainId && !progress?.done;

  return (
    <Dialog open onClose={running ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Drain node {name}</DialogTitle>
      <DialogContent>
        {!drainId && (
          <>
            <Typography variant="body2">
              This cordons <b>{name}</b> and evicts all non-DaemonSet pods. Pods managed by controllers will be rescheduled elsewhere.
            </Typography>
            {isProtected && (
              <>
                <Typography variant="body2" sx={{ mt: 2, mb: 1 }}>
                  This cluster is protected. Type <b>{name}</b> to confirm.
                </Typography>
                <TextField autoFocus fullWidth size="small" placeholder={name} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </>
            )}
          </>
        )}
        {drainId && (
          <>
            <LinearProgress
              variant={progress?.total ? 'determinate' : 'indeterminate'}
              value={progress?.total ? (progress.evicted / progress.total) * 100 : undefined}
              sx={{ mb: 1 }}
            />
            <Typography variant="body2" color="text.secondary">
              {progress?.error
                ? `Failed: ${progress.error}`
                : progress?.done
                  ? `Done — evicted ${progress.evicted}/${progress.total} pods.`
                  : `Evicting ${progress?.current ?? '…'} (${progress?.evicted ?? 0}/${progress?.total ?? '?'})`}
            </Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={running}>
          {progress?.done ? 'Close' : 'Cancel'}
        </Button>
        {!drainId && (
          <Button
            variant="contained"
            color="error"
            disabled={drain.isPending || (isProtected && typed !== name)}
            onClick={() =>
              drain.mutate(
                { ctx: target.ctx, body: { node: name } },
                { onSuccess: (r) => setDrainId(r.drainId), onError: (e) => setProgress({ evicted: 0, total: 0, done: true, error: e instanceof Error ? e.message : String(e) }) },
              )
            }
          >
            Drain
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
