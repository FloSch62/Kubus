import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import Editor from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import type { ResourceDryRunResponse } from '@kubus/shared';
import { copyToClipboard } from '../clipboard.js';
import { newYamlModelPath } from '../monaco-setup.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { useYamlSchema, type YamlEditorProps } from './YamlEditor.js';

export default function YamlEditorImpl({ value, readOnly, onApply, onDryRun, applyLabel = 'Apply', applyUnchanged, onChange, toolbar, schema }: YamlEditorProps) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunText, setDryRunText] = useState<string>();
  const [dryRun, setDryRun] = useState<ResourceDryRunResponse>();
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const copyResetRef = useRef<number | undefined>(undefined);
  const schemaRef = useYamlSchema(schema);
  // Per-mount model path under the schema's glob prefix, so the registered
  // schema matches this editor without reconfiguring the yaml worker.
  const modelPath = useMemo(() => newYamlModelPath(schemaRef), [schemaRef]);

  useEffect(() => {
    setText(value);
    setError(undefined);
    setDryRun(undefined);
    setDryRunText(undefined);
    setCopied(false);
  }, [value]);

  useEffect(
    () => () => {
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
    },
    [],
  );

  const dirty = text !== value;
  const applicable = dirty || !!applyUnchanged;
  const dryRunCurrent = dryRunText === text ? dryRun : undefined;
  // Edits must pass a dry-run before applying; an unedited generated manifest
  // may go straight through — unless a dry-run of it already failed.
  const dryRunRequired = !!onDryRun && !!onApply && dirty;
  const dryRunPassed = dryRunCurrent ? !!dryRunCurrent.ok : !dryRunRequired;

  const copyYaml = async () => {
    setError(undefined);
    const ok = await copyToClipboard(text);
    setCopied(ok);
    if (ok) {
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 2000);
    } else {
      setError('Copy to clipboard failed');
    }
  };

  const apply = async () => {
    if (!onApply) return;
    setBusy(true);
    setError(undefined);
    try {
      await onApply(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    if (!onDryRun) return;
    setDryRunBusy(true);
    setError(undefined);
    try {
      const result = await onDryRun(text);
      setDryRun(result);
      setDryRunText(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDryRun(undefined);
      setDryRunText(undefined);
    } finally {
      setDryRunBusy(false);
    }
  };

  // A dropped YAML file replaces the editor content and goes through the
  // normal edit flow (dirty → dry-run gate → apply). Capture-phase handlers
  // keep Monaco's own text drag-and-drop from swallowing file drops.
  const editable = !(readOnly ?? !onApply);
  const MAX_DROP_BYTES = 2 * 1024 * 1024;

  const loadDroppedFile = async (file: File) => {
    if (file.size > MAX_DROP_BYTES) {
      setError(`${file.name} is too large to load (${Math.round(file.size / 1024)} KiB)`);
      return;
    }
    try {
      const content = await file.text();
      setText(content);
      onChange?.(content);
      setCopied(false);
      setDryRun(undefined);
      setDryRunText(undefined);
      setError(undefined);
    } catch {
      setError(`Could not read ${file.name}`);
    }
  };

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      onDragOverCapture={(e) => {
        if (!editable || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeaveCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDropCapture={(e) => {
        const file = e.dataTransfer.files[0];
        if (!editable || !file) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        void loadDroppedFile(file);
      }}
    >
      <Stack direction="row" spacing={1} sx={{ p: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center', flexShrink: 0 }}>
        {toolbar}
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<ContentCopyIcon fontSize="small" />} color={copied ? 'success' : 'primary'} disabled={!text} onClick={() => void copyYaml()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {onApply ? (
          <>
            {onDryRun ? (
              <Button disabled={!applicable || dryRunBusy || busy} onClick={() => void validate()}>
                {dryRunBusy ? 'Validating…' : dryRunCurrent?.ok ? 'Validated' : 'Dry run'}
              </Button>
            ) : null}
            <Button
              disabled={!dirty || busy}
              onClick={() => {
                setText(value);
                onChange?.(value);
              }}
            >
              Reset
            </Button>
            <Button variant="contained" disabled={!applicable || busy || !dryRunPassed} onClick={() => void apply()}>
              {busy ? 'Applying…' : applyLabel}
            </Button>
          </>
        ) : null}
      </Stack>
      {error ? (
        <Alert severity="error" onClose={() => setError(undefined)} sx={{ borderRadius: 0, flexShrink: 0 }}>
          {error}
        </Alert>
      ) : null}
      {dryRunCurrent?.findings.map((finding, i) => (
        <Alert key={`${finding.field ?? ''}:${i}`} severity={finding.severity === 'error' ? 'error' : finding.severity} sx={{ borderRadius: 0, flexShrink: 0 }}>
          {finding.field ? `${finding.field}: ` : ''}
          {finding.message}
        </Alert>
      ))}
      {dryRunCurrent?.ok && dryRunCurrent.findings.length === 0 ? (
        <Alert severity="success" sx={{ borderRadius: 0, flexShrink: 0 }}>
          Server dry-run accepted this manifest.
        </Alert>
      ) : null}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {dragOver && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'action.hover',
              border: 2,
              borderStyle: 'dashed',
              borderColor: 'primary.main',
              pointerEvents: 'none',
            }}
          >
            <Typography variant="subtitle2" sx={{ bgcolor: 'background.paper', px: 1.5, py: 0.5, borderRadius: 1, boxShadow: 1 }}>
              Drop YAML file to load
            </Typography>
          </Box>
        )}
        <Editor
          language="yaml"
          path={modelPath}
          value={text}
          onChange={(v) => {
            setText(v ?? '');
            onChange?.(v ?? '');
            setCopied(false);
            setDryRun(undefined);
            setDryRunText(undefined);
          }}
          theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
          options={{
            readOnly: readOnly ?? !onApply,
            minimap: { enabled: false },
            fontSize: monoFontSize,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            // Render hover/suggest widgets in a viewport-fixed layer so they
            // aren't clipped by the editor container (drawer sits at the
            // screen edge, so clipped widgets end up off-screen).
            fixedOverflowWidgets: true,
          }}
        />
      </Box>
    </Box>
  );
}
