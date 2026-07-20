import { Suspense, lazy, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import type { ResourceDryRunResponse } from '@kubus/shared';
import { useResourceSchema } from '../api/queries.js';
import type { YamlSchemaRef } from '../monaco-setup.js';

export interface YamlEditorProps {
  value: string;
  readOnly?: boolean;
  onApply?: (yamlText: string) => Promise<void>;
  onDryRun?: (yamlText: string) => Promise<ResourceDryRunResponse>;
  applyLabel?: string;
  /** Enable Apply/Dry run on unedited text — create flows where the generated manifest is already submittable. */
  applyUnchanged?: boolean;
  /** Observe the edited text (e.g. to carry edits across a form/YAML tab switch). */
  onChange?: (yamlText: string) => void;
  /** Extra toolbar content (e.g. reveal-secrets toggle). */
  toolbar?: React.ReactNode;
  /** Kind being edited; enables schema-based hover docs, completion and validation. */
  schema?: YamlSchemaRef;
}

/**
 * Fetch a kind's JSON schema and register it with monaco-yaml. Callers that
 * know the kind ahead of time (e.g. the detail drawer) can invoke this before
 * the editor mounts so the yaml worker is warm when the YAML tab opens. The
 * monaco bundle itself loads on demand, so registration goes through a dynamic
 * import instead of pulling monaco into the startup chunk.
 */
export function useYamlSchema(schema: YamlSchemaRef | undefined): YamlSchemaRef | undefined {
  const { ctx, group, version, kind } = schema ?? {};
  const schemaRef = useMemo<YamlSchemaRef | undefined>(
    () => (ctx !== undefined && group !== undefined && version && kind ? { ctx, group, version, kind } : undefined),
    [ctx, group, version, kind],
  );
  const { data: schemaDoc } = useResourceSchema(schemaRef);
  useEffect(() => {
    if (schemaRef && schemaDoc) {
      void import('../monaco-setup.js').then((m) => m.registerYamlSchema(schemaRef, schemaDoc));
    }
  }, [schemaRef, schemaDoc]);
  return schemaRef;
}

const YamlEditorImpl = lazy(() => import('./YamlEditorImpl.js'));

const editorLoading = (
  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
    <CircularProgress size={24} />
  </Box>
);

export function YamlEditor(props: YamlEditorProps) {
  return (
    <Suspense fallback={editorLoading}>
      <YamlEditorImpl {...props} />
    </Suspense>
  );
}
