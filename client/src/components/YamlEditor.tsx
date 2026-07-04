import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Stack } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import Editor from '@monaco-editor/react';
import { useTheme } from '@mui/material/styles';
import type { ResourceDryRunResponse } from '@kubus/shared';
import { useResourceSchema } from '../api/queries.js';
import { newYamlModelPath, registerYamlSchema, type YamlSchemaRef } from '../monaco-setup.js';
import { useUiPrefsStore } from '../state/prefs.js';

interface Props {
  value: string;
  readOnly?: boolean;
  onApply?: (yamlText: string) => Promise<void>;
  onDryRun?: (yamlText: string) => Promise<ResourceDryRunResponse>;
  applyLabel?: string;
  /** Extra toolbar content (e.g. reveal-secrets toggle). */
  toolbar?: React.ReactNode;
  /** Kind being edited; enables schema-based hover docs, completion and validation. */
  schema?: YamlSchemaRef;
}

/**
 * Fetch a kind's JSON schema and register it with monaco-yaml. Callers that
 * know the kind ahead of time (e.g. the detail drawer) can invoke this before
 * the editor mounts so the yaml worker is warm when the YAML tab opens.
 */
export function useYamlSchema(schema: YamlSchemaRef | undefined): YamlSchemaRef | undefined {
  const { ctx, group, version, kind } = schema ?? {};
  const schemaRef = useMemo<YamlSchemaRef | undefined>(
    () => (ctx !== undefined && group !== undefined && version && kind ? { ctx, group, version, kind } : undefined),
    [ctx, group, version, kind],
  );
  const { data: schemaDoc } = useResourceSchema(schemaRef);
  useEffect(() => {
    if (schemaRef && schemaDoc) registerYamlSchema(schemaRef, schemaDoc);
  }, [schemaRef, schemaDoc]);
  return schemaRef;
}

export function YamlEditor({ value, readOnly, onApply, onDryRun, applyLabel = 'Apply', toolbar, schema }: Props) {
  const theme = useTheme();
  const monoFontSize = useUiPrefsStore((s) => s.monoFontSize);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunText, setDryRunText] = useState<string>();
  const [dryRun, setDryRun] = useState<ResourceDryRunResponse>();
  const [copied, setCopied] = useState(false);
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
  const dryRunCurrent = dryRunText === text ? dryRun : undefined;
  const dryRunRequired = !!onDryRun && !!onApply && dirty;
  const dryRunPassed = !dryRunRequired || dryRunCurrent?.ok;

  const copyYaml = async () => {
    setError(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setCopied(false);
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ p: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center', flexShrink: 0 }}>
        {toolbar}
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<ContentCopyIcon fontSize="small" />} color={copied ? 'success' : 'primary'} disabled={!text} onClick={() => void copyYaml()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
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
          path={modelPath}
          value={text}
          onChange={(v) => {
            setText(v ?? '');
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
