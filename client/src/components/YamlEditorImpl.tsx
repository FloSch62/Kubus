import { useEffect, useMemo, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useTheme } from '@mui/material/styles';
import type { ResourceDryRunResponse } from '@kubus/shared';
import { copyToClipboard } from '../clipboard.js';
import { isSaveChord, isSubmitChord } from '../editor-keys.js';
import { HOTKEY_MOD_LABEL } from '../platform.js';
import { newYamlModelPath } from '../monaco-setup.js';
import { useUiPrefsStore } from '../state/prefs.js';
import { useYamlSchema, type YamlEditorProps } from './YamlEditor.js';
import { MonacoEditor } from './MonacoEditor.js';

export default function YamlEditorImpl({ value, readOnly, onApply, onDryRun, applyLabel = 'Apply', applyUnchanged, onChange, draft, toolbar, schema, onReview, notice }: YamlEditorProps) {
  const theme = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const [text, setText] = useState(draft ?? value);
  const lastValueRef = useRef(value);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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

  // A new base value (server refresh, different object) replaces the text
  // unless the caller supplies a draft for it (edits rebased onto the
  // refreshed object); the initial mount keeps a carried-over draft too.
  useEffect(() => {
    if (lastValueRef.current === value) return;
    lastValueRef.current = value;
    setText(draftRef.current ?? value);
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

  const validate = async (): Promise<ResourceDryRunResponse | undefined> => {
    if (!onDryRun) return undefined;
    setDryRunBusy(true);
    setError(undefined);
    try {
      const result = await onDryRun(text);
      setDryRun(result);
      setDryRunText(text);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDryRun(undefined);
      setDryRunText(undefined);
      return undefined;
    } finally {
      setDryRunBusy(false);
    }
  };

  // Mod+Enter presses the primary button, running the required dry-run
  // first. Findings stop it so they get read; the next Mod+Enter applies.
  const submit = async () => {
    if (!onApply || busy || dryRunBusy || !applicable) return;
    if (!dryRunPassed) {
      if (dryRunCurrent) return;
      const result = await validate();
      if (!result?.ok || result.findings.length > 0) return;
    }
    await apply();
  };

  // A dropped YAML file replaces the editor content and goes through the
  // normal edit flow (dirty → dry-run gate → apply). Capture-phase handlers
  // keep Monaco's own text drag-and-drop from swallowing file drops.
  const editable = !(readOnly ?? !(onApply || onReview));
  const MAX_DROP_BYTES = 2 * 1024 * 1024;

  // Keyboard chords are registered once (Monaco actions, the dialog-wide
  // listener) and read the current handlers from here.
  const chordsRef = useRef<{ review?: () => void; submit?: () => void }>({});
  chordsRef.current = {
    review: onReview ? () => (editable && dirty ? onReview(text) : undefined) : undefined,
    submit: onApply ? () => void submit() : undefined,
  };
  const handleEditorMount: OnMount = (editor, monaco) => {
    // addAction (unlike addCommand) scopes the keybinding to this editor, so
    // several mounted editors (hidden tabs, a create dialog) do not collide.
    const actions = [
      editor.addAction({
        id: 'kubus.review-apply',
        label: 'Review & apply',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => chordsRef.current.review?.(),
      }),
      editor.addAction({
        id: 'kubus.submit',
        label: applyLabel,
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => {
          const submitNow = chordsRef.current.submit;
          if (submitNow) submitNow();
          else editor.trigger('keyboard', 'editor.action.insertLineAfter', null);
        },
      }),
    ];
    editor.onDidDispose(() => {
      for (const action of actions) action.dispose();
    });
  };
  // The same chords with focus outside Monaco: anywhere in the surrounding
  // dialog (a create dialog opens with focus on the dialog itself), or in
  // this editor's toolbar when it is not in a dialog.
  useEffect(() => {
    const root = rootRef.current;
    const scope = root?.closest<HTMLElement>('.MuiDialog-root') ?? root;
    if (!scope) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const { review, submit: submitNow } = chordsRef.current;
      if (review && isSaveChord(event)) {
        event.preventDefault();
        review();
      } else if (submitNow && isSubmitChord(event)) {
        event.preventDefault();
        submitNow();
      }
    };
    scope.addEventListener('keydown', onKey);
    return () => scope.removeEventListener('keydown', onKey);
  }, []);

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
      ref={rootRef}
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
        {onApply || onReview ? (
          <>
            {onDryRun && !onReview ? (
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
            {onReview ? (
              <Tooltip title={`${HOTKEY_MOD_LABEL}S`} describeChild>
                <span>
                  <Button variant="contained" disabled={!dirty || !editable} onClick={() => onReview(text)}>
                    Review & apply
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button variant="contained" disabled={!applicable || busy || !dryRunPassed} onClick={() => void apply()}>
                {busy ? 'Applying…' : applyLabel}
              </Button>
            )}
          </>
        ) : null}
      </Stack>
      {notice}
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
        <MonacoEditor
          language="yaml"
          path={modelPath}
          value={text}
          onMount={handleEditorMount}
          onChange={(v) => {
            setText(v ?? '');
            onChange?.(v ?? '');
            setCopied(false);
            setDryRun(undefined);
            setDryRunText(undefined);
          }}
          theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
          options={{
            readOnly: !editable,
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
