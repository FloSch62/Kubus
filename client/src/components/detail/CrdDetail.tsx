import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { KubeObject } from '@kubus/shared';
import { GenericDetail } from './GenericDetail.js';
import { Section } from './Section.js';
import { statusTextColor } from '../../theme.js';
import {
  MAX_SCHEMA_DEPTH,
  STANDARD_ROOT_FIELDS,
  childFields,
  displayType,
  mergeSchema,
  mergedProperties,
  mergedRequired,
  resolveSchema,
  schemaMeta,
  typeColor,
  type JsonSchema,
} from './schema-walk.js';

export interface CrdVersion {
  name: string;
  served?: boolean;
  storage?: boolean;
  deprecated?: boolean;
  deprecationWarning?: string;
  schema?: { openAPIV3Schema?: JsonSchema };
  subresources?: {
    status?: unknown;
    scale?: {
      specReplicasPath?: string;
      statusReplicasPath?: string;
      labelSelectorPath?: string;
    };
  };
  additionalPrinterColumns?: Array<{ name?: string; type?: string; jsonPath?: string; priority?: number; description?: string }>;
}

interface CrdSpec {
  group?: string;
  names?: {
    kind?: string;
    plural?: string;
    singular?: string;
    shortNames?: string[];
    categories?: string[];
  };
  scope?: string;
  version?: string;
  versions?: CrdVersion[];
  validation?: { openAPIV3Schema?: JsonSchema };
  subresources?: CrdVersion['subresources'];
  additionalPrinterColumns?: CrdVersion['additionalPrinterColumns'];
}


function crdSpec(obj: KubeObject): CrdSpec {
  return (obj.spec ?? {}) as CrdSpec;
}

export function crdVersions(obj: KubeObject | undefined): CrdVersion[] {
  if (!obj) return [];
  const spec = crdSpec(obj);
  if (Array.isArray(spec.versions)) return spec.versions.filter((v) => typeof v?.name === 'string' && v.name.length > 0);
  return spec.version
    ? [
        {
          name: spec.version,
          served: true,
          storage: true,
          schema: spec.validation ? { openAPIV3Schema: spec.validation.openAPIV3Schema } : undefined,
          subresources: spec.subresources,
          additionalPrinterColumns: spec.additionalPrinterColumns,
        },
      ]
    : [];
}

export function CrdDetail({ obj, ctx }: { obj: KubeObject; ctx: string }) {
  const spec = crdSpec(obj);
  const names = spec.names ?? {};
  const versions = crdVersions(obj);
  const storageVersion = versions.find((v) => v.storage)?.name;

  return (
    <GenericDetail obj={obj} ctx={ctx} hideConditions>
      <Section title="Definition">
        <Table size="small">
          <TableBody>
            <InfoRow label="Group" value={spec.group} />
            <InfoRow label="Kind" value={names.kind} />
            <InfoRow label="Plural" value={names.plural} />
            <InfoRow label="Singular" value={names.singular} />
            <InfoRow label="Scope" value={spec.scope} />
            <InfoRow label="Storage version" value={storageVersion} />
            <InfoRow label="Versions" value={versions.map((v) => v.name).join(', ')} />
            <InfoRow label="Short names" value={(names.shortNames ?? []).join(', ')} />
            <InfoRow label="Categories" value={(names.categories ?? []).join(', ')} />
          </TableBody>
        </Table>
      </Section>
    </GenericDetail>
  );
}

/** "Expand all" / "Collapse all" request; `seq` makes repeats observable. */
interface ExpandAll {
  kind: 'expand' | 'collapse';
  seq: number;
}

/**
 * One tab for every version of a CRD: a version picker (storage version
 * first) over the schema browser, with expand/collapse-all for deep schemas.
 * `versionName` seeds the picker (the version a custom resource was opened
 * with); an unknown name shows a hint instead of an empty tree.
 */
export function CrdSchemaDetail({ obj, versionName }: { obj: KubeObject; versionName?: string }) {
  const versions = crdVersions(obj);
  const fallback = versions.find((v) => v.storage)?.name ?? versions[0]?.name;
  const [selected, setSelected] = useState(versionName ?? fallback);
  const [expandAll, setExpandAll] = useState<ExpandAll>();
  const version = versions.find((v) => v.name === selected);
  if (!version) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Version {selected ?? ''} is not defined on this CRD.
      </Typography>
    );
  }

  const schema = version.schema?.openAPIV3Schema;
  const rootFields = rootSchemaFields(schema);
  const printerColumns = version.additionalPrinterColumns ?? [];

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          select
          size="small"
          value={version.name}
          onChange={(e) => setSelected(e.target.value)}
          slotProps={{
            // The closed picker shows only the name; storage/served hints live in the menu.
            select: { 'aria-label': 'Schema version', renderValue: (value) => String(value) },
            input: { sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 13 } },
          }}
          sx={{ minWidth: 140 }}
        >
          {versions.map((v) => (
            <MenuItem key={v.name} value={v.name} sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 13, gap: 1 }}>
              {v.name}
              {v.storage && (
                <Typography component="span" variant="caption" color="text.secondary">
                  storage
                </Typography>
              )}
              {v.served === false && (
                <Typography component="span" variant="caption" color="text.secondary">
                  not served
                </Typography>
              )}
            </MenuItem>
          ))}
        </TextField>
        {version.served !== false && <Chip label="served" variant="outlined" />}
        {version.storage && <Chip label="storage" variant="outlined" />}
        {version.subresources?.status !== undefined && <Chip label="status subresource" variant="outlined" />}
        {version.subresources?.scale !== undefined && <Chip label="scale subresource" variant="outlined" />}
        {version.deprecated && <Chip label="deprecated" color="warning" variant="outlined" />}
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={() => setExpandAll({ kind: 'expand', seq: Date.now() })}>
          Expand all
        </Button>
        <Button size="small" onClick={() => setExpandAll({ kind: 'collapse', seq: Date.now() })}>
          Collapse all
        </Button>
      </Stack>
      {version.deprecationWarning && (
        <Typography variant="body2" sx={{ color: statusTextColor('warning') }}>
          {version.deprecationWarning}
        </Typography>
      )}
      {!schema && (
        <Typography variant="body2" color="text.secondary">
          This CRD version does not publish an OpenAPI v3 schema.
        </Typography>
      )}
      <Box>
        {rootFields.map(({ name, fieldSchema, required }) => (
          <SchemaField key={name} name={name} schema={fieldSchema} required={required} depth={0} definitions={{}} expandAll={expandAll} />
        ))}
      </Box>
      {printerColumns.length > 0 && (
        <Section title="Printer columns" count={printerColumns.length}>
          <Table size="small">
            <TableBody>
              {printerColumns.map((column, index) => (
                <TableRow key={`${column.name ?? index}:${column.jsonPath ?? ''}`}>
                  <TableCell sx={{ width: 180, color: 'text.secondary', border: 0 }}>{column.name ?? ''}</TableCell>
                  <TableCell sx={{ border: 0, wordBreak: 'break-word' }}>
                    <Typography component="span" variant="body2" sx={{ fontWeight: 600, mr: 1, color: typeColor(column.type ?? 'string') }}>
                      {column.type ?? 'string'}
                    </Typography>
                    <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {column.jsonPath ?? ''}
                    </Typography>
                    {column.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {column.description}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </Stack>
  );
}

/** Expandable schema tree for the self-contained OpenAPI document returned by /schema. */
export function OpenApiSchemaDetail({ document }: { document: Record<string, unknown> }) {
  const schema = document as JsonSchema;
  const definitions = schema.definitions ?? {};
  const rootFields = rootSchemaFields(resolveSchema(schema, definitions), definitions);

  return (
    <Box sx={{ p: 2 }}>
      {rootFields.map(({ name, fieldSchema, required }) => (
        <SchemaField
          key={name}
          name={name}
          schema={fieldSchema}
          required={required}
          depth={0}
          definitions={definitions}
        />
      ))}
    </Box>
  );
}

function InfoRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <TableRow>
      <TableCell sx={{ width: 140, color: 'text.secondary', border: 0 }}>{label}</TableCell>
      <TableCell sx={{ border: 0, wordBreak: 'break-word' }}>{value}</TableCell>
    </TableRow>
  );
}

function rootSchemaFields(schema: JsonSchema | undefined, definitions: Record<string, JsonSchema> = {}): Array<{ name: string; fieldSchema: JsonSchema; required: boolean }> {
  const properties = mergedProperties(schema, definitions);
  const required = new Set(mergedRequired(schema, definitions));
  const names = new Set([...Object.keys(STANDARD_ROOT_FIELDS), ...Object.keys(properties)]);
  return [...names].map((name) => ({
    name,
    fieldSchema: mergeSchema(STANDARD_ROOT_FIELDS[name], properties[name]),
    required: required.has(name),
  }));
}

function SchemaField({
  name,
  schema,
  required,
  depth,
  definitions,
  expandAll,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  depth: number;
  definitions: Record<string, JsonSchema>;
  expandAll?: ExpandAll;
}) {
  const resolvedSchema = resolveSchema(schema, definitions);
  const description = resolvedSchema.description ?? resolvedSchema.title;
  const nestedChildren = childFields(resolvedSchema, definitions);
  const children = depth < MAX_SCHEMA_DEPTH ? nestedChildren : [];
  const canExpand = children.length > 0;
  const [expanded, setExpanded] = useState(false);
  // Expand/collapse-all applies in render so the next paint is consistent;
  // later manual toggles win until the next command.
  const lastCommand = useRef<number>(undefined);
  if (expandAll && lastCommand.current !== expandAll.seq) {
    lastCommand.current = expandAll.seq;
    if (expanded !== (expandAll.kind === 'expand')) setExpanded(expandAll.kind === 'expand');
  }
  const meta = schemaMeta(resolvedSchema);
  const typeLabel = displayType(resolvedSchema, definitions);

  const toggleExpanded = () => {
    // Don't collapse/expand when the user is selecting description text.
    if (window.getSelection()?.toString()) return;
    setExpanded((v) => !v);
  };

  return (
    <Box sx={{ ml: depth ? 1.5 : 0, pl: depth ? 1.5 : 0, borderLeft: depth ? 1 : 0, borderColor: 'divider' }}>
      <Box
        onClick={canExpand ? toggleExpanded : undefined}
        sx={{
          py: 0.75,
          ...(canExpand && {
            cursor: 'pointer',
            borderRadius: 1,
            mx: -0.5,
            px: 0.5,
            '&:hover': { bgcolor: 'action.hover' },
          }),
        }}
      >
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
          {canExpand ? (
            <IconButton
              size="small"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
              aria-expanded={expanded}
              sx={{ width: 22, height: 22, mt: -0.25, color: 'text.secondary', flexShrink: 0 }}
            >
              {expanded ? <KeyboardArrowDownIcon sx={{ fontSize: 18 }} /> : <KeyboardArrowRightIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          ) : (
            <Box sx={{ width: 22, flexShrink: 0 }} />
          )}
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Typography component="span" variant="body2" sx={{ fontWeight: 700, color: 'text.primary', fontFamily: depth ? 'monospace' : undefined }}>
                {name}
              </Typography>
              <Typography component="span" variant="body2" sx={{ fontWeight: 600, color: typeColor(typeLabel) }}>
                {typeLabel}
              </Typography>
              {required && <Chip label="required" size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />}
              {resolvedSchema.nullable && <Chip label="nullable" size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />}
              {resolvedSchema['x-kubernetes-preserve-unknown-fields'] && <Chip label="preserve unknown" size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />}
              {meta.map((m) => (
                <Chip key={m} label={m} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, maxWidth: 360 }} title={m} />
              ))}
            </Stack>
            {description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, whiteSpace: 'pre-wrap' }}>
                {description}
              </Typography>
            )}
          </Box>
        </Stack>
      </Box>
      {depth >= MAX_SCHEMA_DEPTH && nestedChildren.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pb: 0.75 }}>
          More nested fields omitted.
        </Typography>
      )}
      {expanded && children.map((child) => (
        <SchemaField
          key={child.name}
          name={child.name}
          schema={child.fieldSchema}
          required={child.required}
          depth={depth + 1}
          definitions={definitions}
          expandAll={expandAll}
        />
      ))}
    </Box>
  );
}
