import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { WASI } from 'node:wasi';
import { HttpProblem } from '../util/errors.js';

/**
 * Helm's chart rendering pipeline (loader → chartutil → engine → releaseutil)
 * compiled from helm.sh/helm/v3 to a WASI module — see /helm-engine. Each call
 * runs a fresh, fully sandboxed instance whose only filesystem access is a
 * scratch dir holding input.json/output.json. The compiled module is cached
 * in memory while helm write-actions are in use and dropped after idle.
 */

/** Hook object exactly as helm stores it in release payloads (snake_case). */
export interface HelmHookPayload {
  name: string;
  kind: string;
  path: string;
  manifest: string;
  events?: string[];
  weight?: number;
  delete_policies?: string[];
  last_run?: Record<string, unknown>;
}

export interface EngineReleaseOptions {
  name: string;
  namespace: string;
  revision: number;
  isInstall?: boolean;
  isUpgrade?: boolean;
}

export interface EngineRenderRequest {
  /** base64 chart .tgz — or chartJSON, the chart object from a release payload. */
  chartArchive?: string;
  chartJSON?: unknown;
  values: Record<string, unknown>;
  release: EngineReleaseOptions;
  kubeVersion?: string;
  apiVersions?: string[];
}

export interface ChartMetadata {
  name: string;
  version: string;
  appVersion?: string;
  description?: string;
  icon?: string;
  home?: string;
  sources?: string[];
  keywords?: string[];
  dependencies?: Array<{ name: string; version: string; repository?: string; condition?: string; alias?: string }>;
}

export interface EngineRenderResult {
  manifest: string;
  hooks: HelmHookPayload[];
  notes: string;
  crds: Array<{ name: string; content: string }>;
  /** Chart object in release-payload form — goes into the new release record. */
  chartJSON: Record<string, unknown>;
  metadata: ChartMetadata;
  computedValues: Record<string, unknown>;
}

export interface EngineInspectResult {
  metadata: ChartMetadata;
  values: Record<string, unknown>;
  valuesYaml: string;
  readme: string;
}

function assetPath(): string {
  if (process.env.KUBUS_HELM_ENGINE) return process.env.KUBUS_HELM_ENGINE;
  // server/src/helm → server/assets (same shape from dist/helm).
  return fileURLToPath(new URL('../../assets/helm-engine.wasm.gz', import.meta.url));
}

export function engineAvailable(): boolean {
  return existsSync(assetPath());
}

const MODULE_IDLE_MS = 10 * 60 * 1000;
let modulePromise: Promise<WebAssembly.Module> | null = null;
let evictTimer: NodeJS.Timeout | null = null;

function getModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    const loading = readFile(assetPath()).then((gz) => WebAssembly.compile(gunzipSync(gz)));
    // A failed load must not stick: cached rejections would fail every helm
    // call until the idle eviction, even after the asset is fixed.
    loading.catch(() => {
      if (modulePromise === loading) modulePromise = null;
    });
    modulePromise = loading;
  }
  if (evictTimer) clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    modulePromise = null;
    evictTimer = null;
  }, MODULE_IDLE_MS);
  evictTimer.unref();
  return modulePromise;
}

async function invoke<T>(input: Record<string, unknown>): Promise<T> {
  if (!engineAvailable()) {
    throw new HttpProblem(501, 'Helm engine not available: build server/assets/helm-engine.wasm.gz with `node helm-engine/build.mjs` (requires Go)');
  }
  const mod = await getModule();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'kubus-helm-'));
  try {
    await writeFile(path.join(workDir, 'input.json'), JSON.stringify(input));
    const wasi = new WASI({
      version: 'preview1',
      args: ['helm-engine', '/work/input.json', '/work/output.json'],
      preopens: { '/work': workDir },
    });
    const instance = await WebAssembly.instantiate(mod, wasi.getImportObject() as WebAssembly.Imports);
    wasi.start(instance);
    const raw = await readFile(path.join(workDir, 'output.json'), 'utf8');
    const out = JSON.parse(raw) as T & { error?: string };
    if (out.error) throw new HttpProblem(422, `helm: ${out.error}`);
    return out;
  } finally {
    void rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function renderChart(req: EngineRenderRequest): Promise<EngineRenderResult> {
  const out = await invoke<EngineRenderResult>({ op: 'render', ...req });
  // Go marshals empty slices it never appended to as null.
  out.hooks ??= [];
  out.crds ??= [];
  out.computedValues ??= {};
  return out;
}

export async function inspectChart(chartArchive: string): Promise<EngineInspectResult> {
  const out = await invoke<EngineInspectResult>({ op: 'inspect', chartArchive });
  // Go marshals a nil values map (empty/comment-only values.yaml) as null.
  out.values ??= {};
  out.valuesYaml ??= '';
  out.readme ??= '';
  return out;
}
