import { useMemo, useState } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { groupToPath, type ListResponse } from '@kubus/shared';
import { useScale, type ClusterRow } from '../api/queries.js';
import { apiFetch } from '../api/http.js';
import { useClustersStore } from '../state/clusters.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { bulkScaleScopes, bulkScaleTargets, commonReplicas, planBulkScale, type BulkScaleTarget } from './bulk-scale.js';

const HPA_GVR = { group: 'autoscaling', version: 'v2', plural: 'horizontalpodautoscalers' } as const;

// Module-level so useQueries only recombines when a lookup result changes.
function combineHpaLookups(results: UseQueryResult<ListResponse>[]) {
  return { pending: results.some((r) => r.isLoading), lists: results.map((r) => r.data?.items) };
}

/**
 * Scale every checked Deployment or StatefulSet to one replica count. Like
 * the single Scale dialog it warns about autoscalers (and leaves autoscaled
 * workloads alone unless overridden) and asks for typed confirmation before
 * taking running workloads on a protected cluster to zero.
 */
export function BulkScaleDialog({
  rows,
  kind,
  group,
  version,
  plural,
  title,
  onClose,
}: {
  rows: ClusterRow[];
  kind: string;
  group: string;
  version: string;
  plural: string;
  /** Plural label of the kind, e.g. "Deployments". */
  title: string;
  onClose: () => void;
}) {
  const scale = useScale();
  const contextSettings = useClustersStore((s) => s.contextSettings);
  const protectByDefault = useUiPrefsStore((s) => s.protectByDefault);
  const scopes = useMemo(() => bulkScaleScopes(rows), [rows]);
  // Same query keys as the single Scale dialog's lookup, so both share cache.
  // A failed lookup counts as "no autoscaler", as it does there.
  const hpaLookups = useQueries({
    queries: scopes.map(({ ctx, namespace }) => ({
      queryKey: ['resource-list', { ctx, ...HPA_GVR, namespace }],
      queryFn: () =>
        apiFetch<ListResponse>(
          `/api/contexts/${encodeURIComponent(ctx)}/resources/${groupToPath(HPA_GVR.group)}/${HPA_GVR.version}/${HPA_GVR.plural}?${new URLSearchParams({ namespace })}`,
        ),
      retry: false,
    })),
    combine: combineHpaLookups,
  });
  const lookupPending = hpaLookups.pending;
  const targets = useMemo(() => {
    const byScope = new Map(scopes.map((scope, i) => [`${scope.ctx}\0${scope.namespace}`, hpaLookups.lists[i]]));
    return bulkScaleTargets(rows, kind, group, (ctx, namespace) => byScope.get(`${ctx}\0${namespace}`));
  }, [rows, kind, group, scopes, hpaLookups.lists]);

  const [replicas, setReplicas] = useState<number | ''>(() => commonReplicas(bulkScaleTargets(rows, kind, group, () => undefined)) ?? '');
  const [override, setOverride] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const isProtected = (ctx: string) => contextSettings[ctx]?.protected ?? protectByDefault;
  const plan = planBulkScale(targets, replicas === '' ? -1 : replicas, override, isProtected);
  const autoscaled = targets.filter((t) => t.scaler);
  const confirmText = `scale ${plan.apply.length} to 0`;
  const blocked = lookupPending || busy || replicas === '' || plan.apply.length === 0 || (plan.guarded && typed !== confirmText);
  const multiCluster = new Set(rows.map((r) => r.ctx)).size > 1;

  const run = async () => {
    if (replicas === '') return;
    const count = replicas;
    const apply = plan.apply;
    setBusy(true);
    const results = await Promise.allSettled(
      apply.map((t) =>
        scale.mutateAsync({
          ctx: t.row.ctx,
          body: { group, version, plural, namespace: t.row.obj.metadata.namespace ?? '', name: t.row.obj.metadata.name, replicas: count },
        }),
      ),
    );
    setBusy(false);
    onClose();
    const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [{ reason: r.reason as unknown, target: apply[i]! }] : []));
    const skippedNote = plan.skipped.length ? `; ${plan.skipped.length} autoscaled left alone` : '';
    if (!failures.length) {
      showToast('success', `Scaled ${apply.length} ${apply.length === 1 ? kind : title} to ${count}${skippedNote}`);
    } else {
      const first = failures[0]!;
      const message = first.reason instanceof Error ? first.reason.message : String(first.reason);
      showToast('error', `Scale failed for ${failures.length} of ${apply.length} — ${first.target.row.obj.metadata.name}: ${message}`);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        Scale {rows.length} {rows.length === 1 ? kind : title}
      </DialogTitle>
      <DialogContent>
        {autoscaled.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {autoscaled.length === rows.length
              ? autoscaled.length === 1
                ? 'This workload has'
                : 'All of these have'
              : autoscaled.length === 1
                ? 'One of these has'
                : `${autoscaled.length} of these have`}{' '}
            replicas managed by an autoscaler:{' '}
            {autoscaled.map((t, i) => (
              <span key={t.row.obj.metadata.uid}>
                {i > 0 && ', '}
                <b>{t.row.obj.metadata.name}</b> by {t.scaler!.kind} {t.scaler!.name} (min {t.scaler!.minReplicas ?? 1} / max {t.scaler!.maxReplicas ?? '?'})
              </span>
            ))}
            . To scale permanently, edit the autoscaler instead.
          </Alert>
        )}
        {autoscaled.length > 0 && (
          <FormControlLabel
            sx={{ mb: 1.5, alignItems: 'flex-start' }}
            control={<Checkbox checked={override} onChange={(e) => setOverride(e.target.checked)} sx={{ mt: -0.75 }} />}
            label={
              <Typography variant="body2">
                Override the autoscaler on these too. The change is temporary and is reverted the next time it reconciles. Left unchecked,
                autoscaled workloads are skipped.
              </Typography>
            }
          />
        )}
        <TextField
          fullWidth
          type="number"
          label="Replicas"
          value={replicas}
          placeholder={commonReplicas(targets) === undefined ? 'Current counts differ' : undefined}
          onChange={(e) => setReplicas(e.target.value === '' ? '' : Math.max(0, Math.floor(Number(e.target.value)) || 0))}
          sx={{
            '& input[type=number]': { MozAppearance: 'textfield', textAlign: 'center' },
            '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': { WebkitAppearance: 'none', margin: 0 },
          }}
          slotProps={{
            htmlInput: { min: 0, autoFocus: true },
            inputLabel: { shrink: true },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <IconButton size="small" aria-label="Decrease replicas" disabled={replicas === '' || replicas <= 0} onClick={() => setReplicas((r) => (r === '' ? r : Math.max(0, r - 1)))}>
                    <RemoveIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" aria-label="Increase replicas" onClick={() => setReplicas((r) => (r === '' ? 1 : r + 1))}>
                    <AddIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
        <Box
          component="ul"
          aria-label="Workloads to scale"
          sx={{ mt: 2, mb: 0, p: 0, listStyle: 'none', maxHeight: 240, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
        >
          {targets.map((t) => (
            <TargetRow key={t.row.obj.metadata.uid} target={t} replicas={replicas} skipped={plan.skipped.includes(t)} multiCluster={multiCluster} />
          ))}
        </Box>
        {plan.guarded && (
          <>
            <Typography variant="body2" sx={{ mt: 2, mb: 1 }}>
              A protected cluster is in this selection and you are scaling running workloads to <b>0</b>. Type <b>{confirmText}</b> to confirm.
            </Typography>
            <TextField fullWidth size="small" placeholder={confirmText} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" disabled={blocked} onClick={() => void run()}>
          {lookupPending ? 'Checking autoscalers…' : plan.skipped.length ? `Scale ${plan.apply.length} of ${rows.length}` : `Scale ${plan.apply.length}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TargetRow({ target, replicas, skipped, multiCluster }: { target: BulkScaleTarget; replicas: number | ''; skipped: boolean; multiCluster: boolean }) {
  const { row, current } = target;
  const next = skipped || replicas === '' ? current : replicas;
  return (
    <Box
      component="li"
      sx={{ display: 'flex', alignItems: 'baseline', gap: 1, px: 1.25, py: 0.5, '&:not(:last-of-type)': { borderBottom: 1, borderColor: 'divider' } }}
    >
      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12.5, flex: 1, minWidth: 0, overflowWrap: 'anywhere', opacity: skipped ? 0.6 : 1 }}>
        {multiCluster ? `${row.ctx}: ` : ''}
        {row.obj.metadata.namespace ? `${row.obj.metadata.namespace}/` : ''}
        {row.obj.metadata.name}
      </Typography>
      <Typography variant="body2" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: skipped ? 'text.secondary' : next !== current ? 'text.primary' : 'text.secondary' }}>
        {skipped ? `${current} · autoscaled, skipped` : next === current ? `${current}` : `${current} → ${next}`}
      </Typography>
    </Box>
  );
}
