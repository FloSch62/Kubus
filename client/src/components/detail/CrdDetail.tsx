import { useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
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

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  nullable?: boolean;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
  'x-kubernetes-int-or-string'?: boolean;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  'x-kubernetes-list-type'?: string;
}

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

const MAX_SCHEMA_DEPTH = 12;

const TYPE_BASE_RE = /[<( ]/;

const STANDARD_ROOT_FIELDS: Record<string, JsonSchema> = {
  apiVersion: {
    type: 'string',
    description: 'Versioned API group and version used by this object.',
  },
  kind: {
    type: 'string',
    description: 'REST resource kind represented by this object.',
  },
  metadata: {
    type: 'object',
    description: 'Standard Kubernetes metadata for the object.',
  },
};

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

export function CrdSchemaDetail({ obj, versionName }: { obj: KubeObject; versionName: string }) {
  const version = crdVersions(obj).find((v) => v.name === versionName);
  if (!version) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Version {versionName} is not defined on this CRD.
      </Typography>
    );
  }

  const schema = version.schema?.openAPIV3Schema;
  const rootFields = rootSchemaFields(schema);
  const printerColumns = version.additionalPrinterColumns ?? [];

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap' }}>
        <Chip label={version.name} color="primary" variant="outlined" />
        {version.served !== false && <Chip label="served" variant="outlined" />}
        {version.storage && <Chip label="storage" variant="outlined" />}
        {version.subresources?.status !== undefined && <Chip label="status subresource" variant="outlined" />}
        {version.subresources?.scale !== undefined && <Chip label="scale subresource" variant="outlined" />}
        {version.deprecated && <Chip label="deprecated" color="warning" variant="outlined" />}
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
          <SchemaField key={name} name={name} schema={fieldSchema} required={required} depth={0} definitions={{}} />
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
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  depth: number;
  definitions: Record<string, JsonSchema>;
}) {
  const resolvedSchema = resolveSchema(schema, definitions);
  const description = resolvedSchema.description ?? resolvedSchema.title;
  const nestedChildren = childFields(resolvedSchema, definitions);
  const children = depth < MAX_SCHEMA_DEPTH ? nestedChildren : [];
  const canExpand = children.length > 0;
  const [expanded, setExpanded] = useState(false);
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
        />
      ))}
    </Box>
  );
}

function childFields(schema: JsonSchema, definitions: Record<string, JsonSchema>): Array<{ name: string; fieldSchema: JsonSchema; required: boolean }> {
  const container = resolveSchema(schema.type === 'array' && schema.items ? schema.items : schema, definitions);
  const properties = mergedProperties(container, definitions);
  const required = new Set(mergedRequired(container, definitions));
  const entries = Object.entries(properties).map(([name, fieldSchema]) => ({ name, fieldSchema, required: required.has(name) }));

  if (entries.length > 0) return entries;
  const additional = container.additionalProperties;
  if (typeof additional === 'object' && additional) {
    const mapChildren = Object.entries(mergedProperties(additional, definitions)).map(([name, fieldSchema]) => ({
      name: `<value>.${name}`,
      fieldSchema,
      required: mergedRequired(additional, definitions).includes(name),
    }));
    if (mapChildren.length > 0) return mapChildren;
  }
  return [];
}

function mergedProperties(schema: JsonSchema | undefined, definitions: Record<string, JsonSchema>): Record<string, JsonSchema> {
  if (!schema) return {};
  const resolved = resolveSchema(schema, definitions);
  const properties: Record<string, JsonSchema> = {};
  for (const branch of resolved.allOf ?? []) Object.assign(properties, mergedProperties(branch, definitions));
  if (resolved.properties) Object.assign(properties, resolved.properties);
  return properties;
}

function mergedRequired(schema: JsonSchema | undefined, definitions: Record<string, JsonSchema>): string[] {
  if (!schema) return [];
  const resolved = resolveSchema(schema, definitions);
  return [...new Set([...(resolved.allOf?.flatMap((branch) => mergedRequired(branch, definitions)) ?? []), ...(resolved.required ?? [])])];
}

function resolveSchema(schema: JsonSchema, definitions: Record<string, JsonSchema>): JsonSchema {
  if (!schema.$ref?.startsWith('#/definitions/')) return schema;
  const referenced = definitions[schema.$ref.slice('#/definitions/'.length)];
  return referenced ? { ...referenced, ...schema, $ref: undefined } : schema;
}

function mergeSchema(base: JsonSchema | undefined, override: JsonSchema | undefined): JsonSchema {
  if (!base) return override ?? {};
  if (!override) return base;
  return { ...base, ...override, description: override.description ?? base.description };
}

function typeColor(typeLabel: string): string {
  const base = typeLabel.split(TYPE_BASE_RE)[0];
  switch (base) {
    case 'string':
      return 'success.main';
    case 'integer':
    case 'number':
    case 'int-or-string':
    case 'date':
      return 'info.main';
    case 'boolean':
      return 'warning.main';
    case 'object':
    case 'map':
      return 'secondary.main';
    case 'array':
      return 'primary.main';
    default:
      return 'text.secondary';
  }
}

function displayType(schema: JsonSchema, definitions: Record<string, JsonSchema> = {}): string {
  const resolved = resolveSchema(schema, definitions);
  if (resolved['x-kubernetes-int-or-string']) return 'int-or-string';
  if (Array.isArray(resolved.type)) return resolved.type.join(' | ');
  if (resolved.type === 'array') return `array<${displayType(resolved.items ?? {}, definitions)}>`;
  if (resolved.type === 'object' && typeof resolved.additionalProperties === 'object') {
    return `map<${displayType(resolved.additionalProperties, definitions)}>`;
  }
  if (resolved.type) return resolved.format ? `${resolved.type} (${resolved.format})` : resolved.type;
  const union = resolved.oneOf ?? resolved.anyOf;
  if (union?.length) return union.map((s) => displayType(s, definitions)).join(' | ');
  if (resolved.allOf?.length) return resolved.allOf.map((s) => displayType(s, definitions)).find((t) => t !== 'unknown') ?? 'object';
  return 'unknown';
}

function schemaMeta(schema: JsonSchema): string[] {
  const meta: string[] = [];
  if (schema.enum?.length) meta.push(`enum: ${schema.enum.map((v) => String(v)).join(', ')}`);
  if (schema.default !== undefined) meta.push(`default: ${JSON.stringify(schema.default)}`);
  if (schema['x-kubernetes-list-type']) meta.push(`list: ${schema['x-kubernetes-list-type']}`);
  return meta;
}
