import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumpYaml } from '../util/yaml.js';

/**
 * Kubeconfig files for local terminals. Each terminal session gets its own
 * file holding exactly one context (cluster + user + context entry) with the
 * namespace Kubus is looking at, and KUBECONFIG points the shell at it. The
 * user's real kubeconfig is never touched: switching cluster in Kubus
 * rewrites this file, and kubectl reads it fresh on every invocation, so the
 * next command lands on the new context without the shell noticing.
 */

interface NamedEntry {
  name: string;
  [key: string]: unknown;
}

export interface ExportedKubeconfig {
  apiVersion?: string;
  kind?: string;
  clusters?: NamedEntry[];
  users?: NamedEntry[];
  contexts?: NamedEntry[];
  'current-context'?: string;
  [key: string]: unknown;
}

/** Drop `undefined` and `null` leaves so the YAML stays kubectl-clean. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

/**
 * Reduce a full exported kubeconfig to the one context, with the namespace
 * override applied. Pure, so it is testable without a cluster.
 */
export function singleContextKubeconfig(full: ExportedKubeconfig, contextName: string, namespace: string | undefined): ExportedKubeconfig {
  const context = (full.contexts ?? []).find((c) => c.name === contextName);
  if (!context) throw new Error(`context "${contextName}" not found`);
  const body = { ...(context.context as Record<string, unknown> | undefined) };
  if (namespace) body.namespace = namespace;
  else delete body.namespace;
  const clusterName = body.cluster as string | undefined;
  const userName = body.user as string | undefined;
  return compact({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': contextName,
    clusters: (full.clusters ?? []).filter((c) => c.name === clusterName),
    users: (full.users ?? []).filter((u) => u.name === userName),
    contexts: [{ name: contextName, context: body }],
    preferences: {},
  }) as ExportedKubeconfig;
}

function sessionDir(): string {
  let owner = 'user';
  try {
    owner = String(os.userInfo().uid ?? os.userInfo().username);
  } catch {
    /* uid unavailable (some Windows accounts): a shared name is still private in the per-user temp dir */
  }
  return path.join(os.tmpdir(), `kubus-${owner}`, 'terminals');
}

/**
 * Path of the kubeconfig file backing one terminal session. The file name
 * leads with the server's pid so a later start can tell its own live files
 * from those a killed server left behind.
 */
export function sessionKubeconfigPath(sessionId: string, pid = process.pid): string {
  return path.join(sessionDir(), `${pid}-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.yaml`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Delete session files whose server is gone. A graceful shutdown removes
 * them itself; this covers crashes and kills, so cluster credentials never
 * linger in the temp dir. Files of other live Kubus servers are kept.
 */
export function sweepStaleSessionKubeconfigs(dir = sessionDir(), isAlive = processAlive): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const match = /^(\d+)-.+\.ya?ml(\.tmp)?$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removed.push(entry);
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/** Atomically (re)write the session's kubeconfig, owner-readable only. */
export function writeSessionKubeconfig(sessionId: string, config: ExportedKubeconfig): string {
  const target = sessionKubeconfigPath(sessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, dumpYaml(config, { lineWidth: -1 }), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

export function removeSessionKubeconfig(sessionId: string): void {
  try {
    fs.unlinkSync(sessionKubeconfigPath(sessionId));
  } catch {
    /* already gone */
  }
}
