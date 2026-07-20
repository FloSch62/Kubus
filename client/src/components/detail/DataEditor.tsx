import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import UndoIcon from '@mui/icons-material/Undo';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { dump as dumpYaml } from 'js-yaml';
import type { KubeObject } from '@kubus/shared';
import { useApplyResource, useDryRunResource, useResource } from '../../api/queries.js';
import { copyToClipboard } from '../../clipboard.js';
import { showToast } from '../../state/toast.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { DiffViewer } from '../DiffViewer.js';
import { formatBytes } from '../format.js';
import {
  REDACTED,
  anyDirty,
  b64ByteLength,
  b64ToBytes,
  b64ToText,
  buildManifest,
  bytesToB64,
  entriesFromObject,
  entryDirty,
  entryRaw,
  maskSecretValues,
  textToB64,
  validateEntries,
  type DataEntry,
  type EntryProblem,
  type ValueMode,
} from './data-editor.js';

export interface DataEditorSelection {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  kind: string;
  name: string;
  namespace?: string;
}

const YAML_OPTS = { noRefs: true, lineWidth: 140 } as const;

function dumpForDiff(obj: KubeObject): string {
  const clone = JSON.parse(JSON.stringify(obj)) as KubeObject;
  delete (clone.metadata as unknown as Record<string, unknown>).managedFields;
  return dumpYaml(clone, YAML_OPTS);
}

function entryByteSize(entry: DataEntry): number {
  return entry.mode === 'binary' ? b64ByteLength(entry.value) : new TextEncoder().encode(entry.value).length;
}

/** Trigger a browser download of the entry's decoded bytes. */
function downloadEntry(entry: DataEntry) {
  let bytes: Uint8Array;
  if (entry.mode === 'binary') {
    try {
      bytes = b64ToBytes(entry.value.replace(/\s/g, ''));
    } catch {
      showToast('error', 'Value is not valid base64');
      return;
    }
  } else {
    bytes = new TextEncoder().encode(entry.value);
  }
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = entry.name || 'value';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Per-key editor for ConfigMap and Secret data. Edits are staged locally
 * (add/rename/edit/delete per key) and applied in one PUT after a diff +
 * server dry-run review. Secret values stay masked until explicitly revealed.
 */
export function DataEditor({ sel, isSecret, onDirtyChange }: { sel: DataEditorSelection; isSecret: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  // Secrets are fetched revealed so the draft holds real values (masked in the
  // UI until per-key reveal); the redacted overview query is separate.
  const { data: latest, error: loadError, refetch } = useResource({ ...sel, reveal: isSecret });
  const [entries, setEntries] = useState<DataEntry[]>();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(new Set<number>());
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<number>>(new Set<number>());
  const [revealAll, setRevealAll] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [review, setReview] = useState(false);
  const nextIdRef = useRef(1);

  useEffect(() => {
    if (latest && !entries) {
      const list = entriesFromObject(latest, isSecret, nextIdRef.current);
      nextIdRef.current += list.length;
      setEntries(list);
    }
  }, [latest, entries, isSecret]);

  const dirty = useMemo(() => (entries ? anyDirty(entries, isSecret) : false), [entries, isSecret]);
  const problems = useMemo(() => validateEntries(entries ?? []), [entries]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const readOnly = latest?.immutable === true;

  const update = (id: number, patch: Partial<DataEntry>) => {
    setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const valueShown = (entry: DataEntry) => !isSecret || !entry.originalName || revealAll || revealedIds.has(entry.id);

  const toggleReveal = (entry: DataEntry) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
  };

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyValue = async (entry: DataEntry) => {
    const ok = await copyToClipboard(entry.mode === 'binary' ? entryRaw(entry, isSecret) : entry.value);
    showToast(ok ? 'success' : 'error', ok ? `Copied value of ${entry.name}` : 'Copy to clipboard failed');
  };

  const addKey = () => {
    const id = nextIdRef.current++;
    setEntries((prev) => [...(prev ?? []), { id, name: '', mode: 'text', value: '', deleted: false }]);
    setExpandedIds((prev) => new Set(prev).add(id));
  };

  const removeKey = (entry: DataEntry) => {
    if (entry.originalName) update(entry.id, { deleted: true });
    else setEntries((prev) => prev?.filter((e) => e.id !== entry.id));
  };

  const setMode = (entry: DataEntry, mode: ValueMode) => {
    if (mode === entry.mode) return;
    if (mode === 'binary') {
      update(entry.id, { mode, value: textToB64(entry.value) });
      return;
    }
    const text = b64ToText(entry.value.replace(/\s/g, ''));
    if (text === undefined) {
      showToast('warning', 'Value is not valid UTF-8 text — keep editing it as base64');
      return;
    }
    update(entry.id, { mode, value: text });
  };

  const uploadFile = (entry: DataEntry, file: File) => {
    void file.arrayBuffer().then((buf) => {
      update(entry.id, { mode: 'binary', value: bytesToB64(new Uint8Array(buf)) });
    });
  };

  const reset = () => {
    setEntries(undefined);
    setExpandedIds(new Set<number>());
    setConfirmReset(false);
  };

  if (loadError) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {loadError instanceof Error ? loadError.message : 'Failed to load resource data'}
      </Alert>
    );
  }
  if (!entries || !latest) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ p: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center', flexShrink: 0 }}>
        {isSecret && (
          <FormControlLabel
            control={<Switch size="small" checked={revealAll} onChange={(e) => setRevealAll(e.target.checked)} />}
            label={<Typography variant="caption">Reveal values</Typography>}
            sx={{ ml: 0 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {!readOnly && (
          <>
            <Button startIcon={<AddIcon fontSize="small" />} onClick={addKey}>
              Add key
            </Button>
            <Button disabled={!dirty} onClick={() => setConfirmReset(true)}>
              Reset
            </Button>
            <Button variant="contained" disabled={!dirty || problems.length > 0} onClick={() => setReview(true)}>
              Review & apply
            </Button>
          </>
        )}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {readOnly && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This {sel.kind} is immutable — its data cannot be changed.
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          {isSecret
            ? 'Secret values are stored base64-encoded. Text mode edits the decoded value and re-encodes it on apply; base64 mode edits the stored payload directly.'
            : 'Text keys are stored as plain UTF-8 strings in data; binary keys are stored base64-encoded in binaryData.'}
        </Typography>
        {entries.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No data keys.
          </Typography>
        )}
        <Stack spacing={1}>
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              isSecret={isSecret}
              readOnly={readOnly}
              expanded={expandedIds.has(entry.id)}
              shown={valueShown(entry)}
              problems={problems}
              onToggleExpanded={() => toggleExpanded(entry.id)}
              onToggleReveal={() => toggleReveal(entry)}
              onCopy={() => void copyValue(entry)}
              onRemove={() => removeKey(entry)}
              onRestore={() => update(entry.id, { deleted: false })}
              onRename={(name) => update(entry.id, { name })}
              onValueChange={(value) => update(entry.id, { value })}
              onModeChange={(mode) => setMode(entry, mode)}
              onUpload={(file) => uploadFile(entry, file)}
              onDownload={() => downloadEntry(entry)}
            />
          ))}
        </Stack>
      </Box>
      <ConfirmDialog
        open={confirmReset}
        title="Discard changes?"
        message="All staged key edits will be discarded and the editor reloaded from the cluster."
        confirmLabel="Discard"
        danger
        onConfirm={reset}
        onClose={() => setConfirmReset(false)}
      />
      {review && (
        <ReviewDialog
          sel={sel}
          isSecret={isSecret}
          latest={latest}
          entries={entries}
          revealAll={revealAll}
          revealedIds={revealedIds}
          onClose={() => setReview(false)}
          onApplied={(updated) => {
            setReview(false);
            setExpandedIds(new Set<number>());
            // Rebuild the draft from the PUT response — the query cache only
            // catches up after the invalidation refetch lands.
            const list = entriesFromObject(updated, isSecret, nextIdRef.current);
            nextIdRef.current += list.length;
            setEntries(list);
            void refetch();
            showToast('success', `${sel.kind} ${sel.name} updated`);
          }}
          onConflict={() => void refetch()}
        />
      )}
    </Box>
  );
}

function entryStatus(entry: DataEntry, isSecret: boolean): { label: string; color: 'success' | 'warning' | 'error' } | undefined {
  if (!entry.originalName) return { label: 'new', color: 'success' };
  if (entry.deleted) return { label: 'deleted', color: 'error' };
  if (entry.name !== entry.originalName) return { label: 'renamed', color: 'warning' };
  if (entryDirty(entry, isSecret)) return { label: 'edited', color: 'warning' };
  return undefined;
}

function entryPreview(entry: DataEntry, shown: boolean): string {
  if (entry.deleted) return 'Will be removed on apply';
  if (!shown) return REDACTED;
  if (entry.mode === 'binary') return `binary · ${formatBytes(entryByteSize(entry))}`;
  const lines = entry.value.split('\n');
  const first = lines[0] ?? '';
  return lines.length > 1 ? `${first} … (${lines.length} lines)` : first;
}

function EntryRow({
  entry,
  isSecret,
  readOnly,
  expanded,
  shown,
  problems,
  onToggleExpanded,
  onToggleReveal,
  onCopy,
  onRemove,
  onRestore,
  onRename,
  onValueChange,
  onModeChange,
  onUpload,
  onDownload,
}: {
  entry: DataEntry;
  isSecret: boolean;
  readOnly: boolean;
  expanded: boolean;
  shown: boolean;
  problems: EntryProblem[];
  onToggleExpanded: () => void;
  onToggleReveal: () => void;
  onCopy: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onRename: (name: string) => void;
  onValueChange: (value: string) => void;
  onModeChange: (mode: ValueMode) => void;
  onUpload: (file: File) => void;
  onDownload: () => void;
}) {
  const status = entryStatus(entry, isSecret);
  const nameProblem = problems.find((p) => p.id === entry.id && p.target === 'name');
  const valueProblem = problems.find((p) => p.id === entry.id && p.target === 'value');
  const multiline = entry.mode === 'binary' || entry.value.includes('\n');
  return (
    <Box sx={{ border: 1, borderColor: nameProblem || valueProblem ? 'error.main' : 'divider', borderRadius: 1, opacity: entry.deleted ? 0.6 : 1 }}>
      <Stack direction="row" sx={{ alignItems: 'center', pr: 1 }}>
        <ButtonBase
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', alignItems: 'center', gap: 1, px: 1, py: 0.5, textAlign: 'left', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
        >
          <KeyboardArrowRightIcon
            sx={{ fontSize: 18, color: 'text.secondary', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}
          />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 600, fontFamily: 'monospace', textDecoration: entry.deleted ? 'line-through' : 'none' }}>
              {entry.name || '(unnamed key)'}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', fontFamily: 'monospace' }}>
              {entryPreview(entry, shown)}
            </Typography>
          </Box>
          {status && <Chip label={status.label} size="small" color={status.color} variant="outlined" sx={{ flexShrink: 0 }} />}
          {entry.mode === 'binary' && !entry.deleted && <Chip label="binary" size="small" variant="outlined" sx={{ flexShrink: 0 }} />}
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, minWidth: 42, textAlign: 'right' }}>
            {formatBytes(entryByteSize(entry))}
          </Typography>
        </ButtonBase>
        <Stack direction="row" sx={{ flexShrink: 0, ml: 0.5 }}>
          {isSecret && entry.originalName && (
            <Tooltip title={shown ? 'Hide value' : 'Reveal value'}>
              <IconButton size="small" onClick={onToggleReveal} aria-label={shown ? `Hide value of ${entry.name}` : `Reveal value of ${entry.name}`}>
                {shown ? <VisibilityOffOutlinedIcon fontSize="small" /> : <VisibilityOutlinedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={entry.mode === 'binary' ? 'Copy base64 value' : 'Copy value'}>
            <IconButton size="small" onClick={onCopy} aria-label={`Copy value of ${entry.name}`}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {!readOnly &&
            (entry.deleted ? (
              <Tooltip title="Restore key">
                <IconButton size="small" onClick={onRestore} aria-label={`Restore ${entry.name}`}>
                  <UndoIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Delete key">
                <IconButton size="small" onClick={onRemove} aria-label={`Delete ${entry.name}`}>
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ))}
        </Stack>
      </Stack>
      <Collapse in={expanded && !entry.deleted} timeout={150} unmountOnExit>
        <Stack spacing={1.5} sx={{ px: 1.5, pb: 1.5, pt: 1, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <TextField
              label="Key"
              size="small"
              value={entry.name}
              onChange={(e) => onRename(e.target.value)}
              disabled={readOnly}
              error={!!nameProblem}
              helperText={nameProblem?.message}
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
              sx={{ width: 320, maxWidth: '100%' }}
            />
            <ToggleButtonGroup size="small" exclusive value={entry.mode} onChange={(_e, v) => v && onModeChange(v as ValueMode)}>
              <ToggleButton value="text" disabled={readOnly}>
                Text
              </ToggleButton>
              <ToggleButton value="binary" disabled={readOnly}>
                Base64
              </ToggleButton>
            </ToggleButtonGroup>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Download value as a file">
              <IconButton size="small" onClick={onDownload} aria-label={`Download value of ${entry.name}`}>
                <DownloadOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {!readOnly && (
              <Tooltip title="Replace value with a file's content">
                <IconButton size="small" component="label" aria-label={`Upload file into ${entry.name}`}>
                  <UploadFileOutlinedIcon fontSize="small" />
                  <input
                    hidden
                    type="file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onUpload(file);
                      e.target.value = '';
                    }}
                  />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
          {shown ? (
            <TextField
              label={entry.mode === 'binary' ? 'Value (base64)' : 'Value'}
              size="small"
              fullWidth
              multiline
              minRows={multiline ? 6 : 1}
              maxRows={18}
              value={entry.value}
              onChange={(e) => onValueChange(e.target.value)}
              disabled={readOnly}
              error={!!valueProblem}
              helperText={valueProblem?.message}
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
            />
          ) : (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                Value is hidden.
              </Typography>
              <Button size="small" startIcon={<VisibilityOutlinedIcon fontSize="small" />} onClick={onToggleReveal}>
                Reveal to view or edit
              </Button>
            </Stack>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

/**
 * Diff + server dry-run gate in front of the apply. Secret values stay masked
 * in the diff unless the key was revealed or its value was authored by the
 * user in this draft (an edit must never be invisible in the review).
 */
function ReviewDialog({
  sel,
  isSecret,
  latest,
  entries,
  revealAll,
  revealedIds,
  onClose,
  onApplied,
  onConflict,
}: {
  sel: DataEditorSelection;
  isSecret: boolean;
  latest: KubeObject;
  entries: DataEntry[];
  revealAll: boolean;
  revealedIds: ReadonlySet<number>;
  onClose: () => void;
  onApplied: (updated: KubeObject) => void;
  onConflict: () => void;
}) {
  const apply = useApplyResource();
  const dryRun = useDryRunResource();
  const [error, setError] = useState<string>();

  const manifest = useMemo(() => buildManifest(latest, entries, isSecret), [latest, entries, isSecret]);
  const yamlBody = useMemo(() => dumpYaml(manifest, YAML_OPTS), [manifest]);
  const { left, right } = useMemo(() => {
    if (!isSecret) return { left: dumpForDiff(latest), right: dumpForDiff(manifest) };
    const revealed = (e: DataEntry) => !e.originalName || revealAll || revealedIds.has(e.id);
    const shownOld = new Set(entries.filter((e) => e.originalName && revealed(e)).map((e) => e.originalName));
    // User-authored values always show — an edit must never be invisible in the diff.
    const shownNew = new Set(entries.filter((e) => !e.deleted && (revealed(e) || entryDirty(e, isSecret))).map((e) => e.name));
    return {
      left: dumpForDiff(maskSecretValues(latest, (name) => shownOld.has(name))),
      right: dumpForDiff(maskSecretValues(manifest, (name) => shownNew.has(name))),
    };
  }, [latest, manifest, entries, isSecret, revealAll, revealedIds]);

  const dryRunMutate = dryRun.mutate;
  useEffect(() => {
    dryRunMutate({ ctx: sel.ctx, yamlBody });
  }, [dryRunMutate, sel.ctx, yamlBody]);

  const doApply = async () => {
    setError(undefined);
    try {
      const updated = await apply.mutateAsync({ ctx: sel.ctx, group: sel.group, version: sel.version, plural: sel.plural, name: sel.name, namespace: sel.namespace, yamlBody });
      onApplied(updated);
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        onConflict();
        setError(`${(err as Error).message} — the resource changed on the server; the diff has been refreshed, review it and apply again.`);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const findings = dryRun.data?.findings ?? [];
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        Review changes — {sel.namespace ? `${sel.namespace}/` : ''}
        {sel.name}
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, display: 'flex', flexDirection: 'column', height: '68vh' }}>
        {error && (
          <Alert severity="error" onClose={() => setError(undefined)} sx={{ borderRadius: 0, flexShrink: 0 }}>
            {error}
          </Alert>
        )}
        {dryRun.isError && (
          <Alert severity="error" sx={{ borderRadius: 0, flexShrink: 0 }}>
            Dry-run failed: {dryRun.error instanceof Error ? dryRun.error.message : 'unknown error'}
          </Alert>
        )}
        {findings.map((finding, i) => (
          <Alert key={`${finding.field ?? ''}:${i}`} severity={finding.severity === 'error' ? 'error' : finding.severity} sx={{ borderRadius: 0, flexShrink: 0 }}>
            {finding.field ? `${finding.field}: ` : ''}
            {finding.message}
          </Alert>
        ))}
        {dryRun.data?.ok && findings.length === 0 && (
          <Alert severity="success" sx={{ borderRadius: 0, flexShrink: 0 }}>
            Server dry-run accepted this change.
          </Alert>
        )}
        {isSecret && (
          <Alert severity="info" sx={{ borderRadius: 0, flexShrink: 0 }}>
            Unrevealed Secret values are shown as {REDACTED} in this diff; the apply uses the real values.
          </Alert>
        )}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <DiffViewer left={left} right={right} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={apply.isPending || dryRun.isPending || !dryRun.data?.ok} onClick={() => void doApply()}>
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
