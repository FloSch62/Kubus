import { useEffect, useState } from 'react';
import { Alert, Box, Button, Stack } from '@mui/material';
import Editor from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import type { ResourceDryRunResponse } from '@kubus/shared';
import { useUiPrefsStore } from '../state/prefs.js';

interface Props {
  value: string;
  readOnly?: boolean;
  onApply?: (yamlText: string) => Promise<void>;
  onDryRun?: (yamlText: string) => Promise<ResourceDryRunResponse>;
  applyLabel?: string;
  /** Extra toolbar content (e.g. reveal-secrets toggle). */
  toolbar?: React.ReactNode;
}

export function YamlEditor({ value, readOnly, onApply, onDryRun, applyLabel = 'Apply', toolbar }: Props) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunText, setDryRunText] = useState<string>();
  const [dryRun, setDryRun] = useState<ResourceDryRunResponse>();

  useEffect(() => {
    setText(value);
    setError(undefined);
    setDryRun(undefined);
    setDryRunText(undefined);
  }, [value]);

  const dirty = text !== value;
  const dryRunCurrent = dryRunText === text ? dryRun : undefined;
  const dryRunRequired = !!onDryRun && !!onApply && dirty;
  const dryRunPassed = !dryRunRequired || dryRunCurrent?.ok;

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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {(onApply || toolbar) && (
        <Stack direction="row" spacing={1} sx={{ p: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center', flexShrink: 0 }}>
          {toolbar}
          <Box sx={{ flex: 1 }} />
          {onApply && (
            <>
              {onDryRun && (
                <Button disabled={!dirty || dryRunBusy || busy} onClick={() => void validate()}>
                  {dryRunBusy ? 'Validating…' : dryRunCurrent?.ok ? 'Validated' : 'Dry run'}
                </Button>
              )}
              <Button disabled={!dirty || busy} onClick={() => setText(value)}>
                Reset
              </Button>
              <Button variant="contained" disabled={!dirty || busy || !dryRunPassed} onClick={() => void apply()}>
                {busy ? 'Applying…' : applyLabel}
              </Button>
            </>
          )}
        </Stack>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError(undefined)} sx={{ borderRadius: 0, flexShrink: 0 }}>
          {error}
        </Alert>
      )}
      {dryRunCurrent?.findings.map((finding, i) => (
        <Alert key={`${finding.field ?? ''}:${i}`} severity={finding.severity === 'error' ? 'error' : finding.severity} sx={{ borderRadius: 0, flexShrink: 0 }}>
          {finding.field ? `${finding.field}: ` : ''}
          {finding.message}
        </Alert>
      ))}
      {dryRunCurrent?.ok && dryRunCurrent.findings.length === 0 && (
        <Alert severity="success" sx={{ borderRadius: 0, flexShrink: 0 }}>
          Server dry-run accepted this manifest.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Editor
          language="yaml"
          value={text}
          onChange={(v) => {
            setText(v ?? '');
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
          }}
        />
      </Box>
    </Box>
  );
}
