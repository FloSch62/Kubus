import type { FastifyBaseLogger } from 'fastify';
import type { KubernetesObject } from '@kubernetes/client-node';
import type { ClusterHandle } from '../kube/cluster-manager.js';
import { HttpProblem } from '../util/errors.js';
import { loadYaml } from '../util/yaml.js';
import { applyDoc, deleteDoc, docLabel, pathForDoc } from './common.js';
import type { HelmHookPayload } from './engine.js';

export type HelmHookEvent =
  | 'pre-install'
  | 'post-install'
  | 'pre-upgrade'
  | 'post-upgrade'
  | 'pre-rollback'
  | 'post-rollback'
  | 'pre-delete'
  | 'post-delete';

export type HelmHookProgress = (message: string, resource: string) => void;

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 2000;

function hookDoc(hook: HelmHookPayload, namespace: string): KubernetesObject | undefined {
  const parsed = loadYaml(hook.manifest);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as KubernetesObject;
  if (!obj.kind || !obj.metadata?.name) return undefined;
  obj.metadata.namespace ??= namespace;
  return obj;
}

async function waitDeleted(handle: ClusterHandle, doc: KubernetesObject): Promise<void> {
  const path = await pathForDoc(handle, doc, false);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await handle.raw.request(path);
    if (res.status === 404) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out waiting for previous hook ${docLabel(doc)} to be deleted`);
}

interface JobStatus {
  status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> };
}

interface PodStatus {
  status?: { phase?: string; message?: string };
}

/** Wait for Job completion / Pod termination the way helm's WatchUntilReady does; other kinds return immediately. */
async function waitHookCompletion(handle: ClusterHandle, doc: KubernetesObject): Promise<void> {
  if (doc.kind !== 'Job' && doc.kind !== 'Pod') return;
  const path = await pathForDoc(handle, doc, false);
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (doc.kind === 'Job') {
      const job = await handle.raw.json<JobStatus>(path);
      const conditions = job.status?.conditions ?? [];
      if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return;
      const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
      if (failed) throw new Error(failed.message || 'job failed');
    } else {
      const pod = await handle.raw.json<PodStatus>(path);
      if (pod.status?.phase === 'Succeeded') return;
      if (pod.status?.phase === 'Failed') throw new Error(pod.status.message || 'pod failed');
    }
  }
  throw new Error(`timed out after ${HOOK_TIMEOUT_MS / 1000}s waiting for completion`);
}

/**
 * Execute the hooks of one lifecycle event the way helm does: filter by event,
 * sort by weight, honor delete policies (an unset policy means
 * before-hook-creation), wait for Jobs/Pods to finish, abort on first failure.
 */
export async function execHooks(
  handle: ClusterHandle,
  hooks: HelmHookPayload[] | undefined,
  event: HelmHookEvent,
  namespace: string,
  log: FastifyBaseLogger,
  ran: string[],
  report?: HelmHookProgress,
): Promise<void> {
  const matching = (hooks ?? [])
    .filter((h) => h.events?.includes(event))
    .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0) || a.name.localeCompare(b.name));

  for (const hook of matching) {
    const doc = hookDoc(hook, namespace);
    if (!doc) continue;
    const label = docLabel(doc);
    const policies = hook.delete_policies?.length ? hook.delete_policies : ['before-hook-creation'];
    report?.(`Preparing ${event} hook`, label);

    if (policies.includes('before-hook-creation')) {
      try {
        if (await deleteDoc(handle, doc)) await waitDeleted(handle, doc);
      } catch (err) {
        log.warn({ label, err: String(err) }, 'helm hook: pre-creation cleanup failed');
      }
    }

    try {
      await applyDoc(handle, doc);
      ran.push(`${event}: ${label}`);
      report?.(doc.kind === 'Job' || doc.kind === 'Pod' ? `Waiting for ${event} hook` : `Ran ${event} hook`, label);
      await waitHookCompletion(handle, doc);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ label, event, err: message }, 'helm hook failed');
      if (policies.includes('hook-failed')) {
        await deleteDoc(handle, doc).catch(() => {});
      }
      throw new HttpProblem(500, `${event} hook ${label} failed: ${message}`);
    }

    if (policies.includes('hook-succeeded')) {
      await deleteDoc(handle, doc).catch((err: unknown) => log.warn({ label, err: String(err) }, 'helm hook: post-success delete failed'));
    }
  }
}
