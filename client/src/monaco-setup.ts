// Bundle Monaco locally (no CDN) and wire its workers for Vite.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import YamlWorker from 'monaco-yaml/yaml.worker?worker';
import { loader } from '@monaco-editor/react';
import { configureMonacoYaml, type SchemasSettings } from 'monaco-yaml';

const workerFor = (label: string): Worker => (label === 'yaml' ? new YamlWorker() : new EditorWorker());

self.MonacoEnvironment = {
  getWorker: (_moduleId, label) => workerFor(label),
};

loader.config({ monaco });

/**
 * monaco-yaml (via monaco-worker-manager) still calls the pre-0.53
 * createWebWorker({ moduleId, label, createData }) API; monaco >= 0.53 expects
 * the caller to create the worker and prime it with two messages (an init
 * trigger, then createData) before handing it over — see monaco-editor's own
 * esm/vs/common/workers.js, which its bundled language services use. Give
 * configureMonacoYaml a monaco facade whose createWebWorker bridges the two,
 * otherwise the yaml worker handshake fails and monaco silently falls back to
 * a main-thread editor worker that lacks the yaml methods.
 */
const monacoForYaml = {
  ...monaco,
  editor: {
    ...monaco.editor,
    createWebWorker: <T extends object>(opts: { label?: string; createData?: unknown; host?: Record<string, Function>; keepIdleModels?: boolean }): monaco.editor.MonacoWebWorker<T> => {
      const worker = workerFor(opts.label ?? '');
      worker.postMessage('ignore'); // wakes the worker's initialize hook
      worker.postMessage(opts.createData); // consumed by monaco's compat shim as createData
      return monaco.editor.createWebWorker<T>({ worker, host: opts.host, keepIdleModels: opts.keepIdleModels });
    },
  },
} as unknown as typeof monaco;

// isKubernetes: manifests dumped by the API server contain explicit nulls
// (e.g. creationTimestamp: null in pod templates) that plain JSON Schema
// validation would flag; kubernetes mode accepts null wherever a type is set.
const yamlDefaults = {
  hover: true,
  completion: true,
  validate: true,
  isKubernetes: true,
  enableSchemaRequest: false,
};

const monacoYaml = configureMonacoYaml(monacoForYaml, yamlDefaults);

export interface YamlSchemaRef {
  ctx: string;
  group: string;
  version: string;
  kind: string;
}

/** Glob- and URI-safe slug; the hash keeps exotic context names (EKS ARNs…) collision-free. */
function slug(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.replace(/[^\w.-]/g, '_')}-${(h >>> 0).toString(36)}`;
}

/** Cluster + GVK → cache key; also the path prefix its editor models live under. */
const schemaKey = (ref: YamlSchemaRef): string => `${slug(ref.ctx)}/${ref.group || 'core'}/${ref.version}/${ref.kind}`;

/**
 * Registered schemas live for the whole session and match models via glob, so
 * editor mounts/unmounts don't touch the yaml language configuration. That
 * matters because every update() makes monaco-worker-manager restart the yaml
 * worker, which then has to recompile every registered schema — the worker
 * only restarts when a not-yet-seen kind (or changed schema content) arrives.
 */
const gvkSchemas = new Map<string, { json: string; entry: SchemasSettings }>();

export function registerYamlSchema(ref: YamlSchemaRef, schema: object): void {
  const key = schemaKey(ref);
  const json = JSON.stringify(schema);
  if (gvkSchemas.get(key)?.json === json) return;
  gvkSchemas.set(key, {
    json,
    entry: {
      fileMatch: [`**/kubus-gvk/${key}/*.yaml`],
      schema,
      // The last segment (kind) shows as the hover's "Source:" link.
      uri: `kubus://schema/${key}`,
    },
  });
  void monacoYaml.update({ ...yamlDefaults, schemas: [...gvkSchemas.values()].map((v) => v.entry) });
}

let nextModelId = 0;

/** Unique per-mount model path, placed under the schema's glob when a kind is known. */
export function newYamlModelPath(ref?: YamlSchemaRef): string {
  nextModelId += 1;
  return ref ? `kubus-gvk/${schemaKey(ref)}/${nextModelId}.yaml` : `kubus-${nextModelId}.yaml`;
}
