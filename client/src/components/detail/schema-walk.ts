/**
 * OpenAPI / JSON-schema helpers shared by the CRD schema browser and the
 * manifest tree: `$ref` resolution against a document's definitions,
 * `allOf` property merging and a compact type label per field.
 */
export interface JsonSchema {
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

export type SchemaDefinitions = Record<string, JsonSchema>;

export const MAX_SCHEMA_DEPTH = 12;

const TYPE_BASE_RE = /[<( ]/;

export const STANDARD_ROOT_FIELDS: Record<string, JsonSchema> = {
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

export function resolveSchema(schema: JsonSchema, definitions: SchemaDefinitions): JsonSchema {
  if (!schema.$ref?.startsWith('#/definitions/')) return schema;
  const referenced = definitions[schema.$ref.slice('#/definitions/'.length)];
  return referenced ? { ...referenced, ...schema, $ref: undefined } : schema;
}

export function mergeSchema(base: JsonSchema | undefined, override: JsonSchema | undefined): JsonSchema {
  if (!base) return override ?? {};
  if (!override) return base;
  return { ...base, ...override, description: override.description ?? base.description };
}

export function mergedProperties(schema: JsonSchema | undefined, definitions: SchemaDefinitions): Record<string, JsonSchema> {
  if (!schema) return {};
  const resolved = resolveSchema(schema, definitions);
  const properties: Record<string, JsonSchema> = {};
  for (const branch of resolved.allOf ?? []) Object.assign(properties, mergedProperties(branch, definitions));
  if (resolved.properties) Object.assign(properties, resolved.properties);
  return properties;
}

export function mergedRequired(schema: JsonSchema | undefined, definitions: SchemaDefinitions): string[] {
  if (!schema) return [];
  const resolved = resolveSchema(schema, definitions);
  return [...new Set([...(resolved.allOf?.flatMap((branch) => mergedRequired(branch, definitions)) ?? []), ...(resolved.required ?? [])])];
}

export function childFields(schema: JsonSchema, definitions: SchemaDefinitions): Array<{ name: string; fieldSchema: JsonSchema; required: boolean }> {
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

/** Theme color key for a type label (`array<string>` → the array color). */
export function typeColor(typeLabel: string): string {
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

export function displayType(schema: JsonSchema, definitions: SchemaDefinitions = {}): string {
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

export function schemaMeta(schema: JsonSchema): string[] {
  const meta: string[] = [];
  if (schema.enum?.length) meta.push(`enum: ${schema.enum.map((v) => String(v)).join(', ')}`);
  if (schema.default !== undefined) meta.push(`default: ${JSON.stringify(schema.default)}`);
  if (schema['x-kubernetes-list-type']) meta.push(`list: ${schema['x-kubernetes-list-type']}`);
  return meta;
}

/**
 * The schema describing the value at `path` inside an object typed by `root`:
 * object keys walk `properties` (falling back to `additionalProperties` for
 * maps), array indices walk `items`. Undefined once the path leaves what the
 * schema describes (unknown fields, preserve-unknown-fields subtrees).
 */
export function schemaAt(root: JsonSchema | undefined, definitions: SchemaDefinitions, path: ReadonlyArray<string | number>): JsonSchema | undefined {
  let current = root ? resolveSchema(root, definitions) : undefined;
  for (const segment of path) {
    if (!current) return undefined;
    if (typeof segment === 'number') {
      current = current.items ? resolveSchema(current.items, definitions) : undefined;
      continue;
    }
    const property = mergedProperties(current, definitions)[segment];
    if (property) {
      current = resolveSchema(property, definitions);
      continue;
    }
    const additional = current.additionalProperties;
    current = typeof additional === 'object' && additional ? resolveSchema(additional, definitions) : undefined;
  }
  return current;
}

/** The `definitions` map of a self-contained schema document (empty when absent). */
export function schemaDefinitions(document: unknown): SchemaDefinitions {
  const defs = (document as JsonSchema | undefined)?.definitions;
  return defs && typeof defs === 'object' ? defs : {};
}
