import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { KubeConfig } from '@kubernetes/client-node';
import { HttpProblem } from '../util/errors.js';

interface NamedEntry {
  name: string;
  [key: string]: unknown;
}

interface KubeconfigDoc {
  apiVersion?: string;
  kind?: string;
  'current-context'?: string;
  clusters?: NamedEntry[];
  users?: NamedEntry[];
  contexts?: NamedEntry[];
  [key: string]: unknown;
}

export interface MergeResult {
  merged: string;
  added: { contexts: string[]; clusters: string[]; users: string[] };
  skipped: string[];
  conflicts: string[];
}

function asEntries(value: unknown): NamedEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is NamedEntry => !!e && typeof e === 'object' && typeof (e as NamedEntry).name === 'string');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge a pasted kubeconfig into an existing one, by entry name. The raw YAML
 * objects are merged (not KubeConfig.exportConfig output) so unknown fields
 * and the existing file's structure are preserved faithfully.
 */
export function mergeKubeconfig(existingYaml: string | null, incomingYaml: string, overwrite: boolean): MergeResult {
  // Validate with the real parser first: garbage in → 400 out.
  const probe = new KubeConfig();
  try {
    probe.loadFromString(incomingYaml);
  } catch (err) {
    throw new HttpProblem(400, `not a valid kubeconfig: ${err instanceof Error ? err.message : String(err)}`, 'BadRequest');
  }
  if (probe.getContexts().length === 0) {
    throw new HttpProblem(400, 'kubeconfig contains no contexts', 'BadRequest');
  }

  const incoming = (yaml.load(incomingYaml) ?? {}) as KubeconfigDoc;
  const existing: KubeconfigDoc | null = existingYaml?.trim() ? ((yaml.load(existingYaml) ?? {}) as KubeconfigDoc) : null;

  const added = { contexts: [] as string[], clusters: [] as string[], users: [] as string[] };
  const skipped: string[] = [];
  const conflicts: string[] = [];

  if (!existing) {
    const doc: KubeconfigDoc = {
      apiVersion: incoming.apiVersion ?? 'v1',
      kind: incoming.kind ?? 'Config',
      ...incoming,
    };
    if (!doc['current-context']) doc['current-context'] = asEntries(incoming.contexts)[0]?.name;
    added.contexts = asEntries(incoming.contexts).map((e) => e.name);
    added.clusters = asEntries(incoming.clusters).map((e) => e.name);
    added.users = asEntries(incoming.users).map((e) => e.name);
    return { merged: yaml.dump(doc, { lineWidth: -1 }), added, skipped, conflicts };
  }

  for (const section of ['clusters', 'users', 'contexts'] as const) {
    const target = asEntries(existing[section]);
    for (const entry of asEntries(incoming[section])) {
      const idx = target.findIndex((e) => e.name === entry.name);
      const label = `${section.slice(0, -1)}/${entry.name}`;
      if (idx === -1) {
        target.push(entry);
        added[section].push(entry.name);
      } else if (deepEqual(target[idx], entry)) {
        skipped.push(label);
      } else if (overwrite) {
        target[idx] = entry;
        added[section].push(entry.name);
      } else {
        conflicts.push(label);
      }
    }
    existing[section] = target;
  }

  // Never touch current-context of an existing file.
  return { merged: yaml.dump(existing, { lineWidth: -1 }), added, skipped, conflicts };
}

/**
 * Write the merged kubeconfig: rolling backup of the previous file, then an
 * atomic tmp+rename write. Returns the backup path (null if nothing existed).
 */
export function writeKubeconfig(targetPath: string, content: string): string | null {
  let backupPath: string | null = null;
  let mode = 0o600;
  if (fs.existsSync(targetPath)) {
    try {
      mode = fs.statSync(targetPath).mode & 0o777;
    } catch {
      /* keep default */
    }
    backupPath = `${targetPath}.kubus.bak`;
    fs.copyFileSync(targetPath, backupPath);
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, targetPath);
  return backupPath;
}
