import fs from 'node:fs';
import path from 'node:path';
import type { User } from '@kubernetes/client-node';
import type { ClusterAuthType } from '@kubus/shared';
import type { RawClient } from './raw-client.js';

/**
 * Turns raw connection/auth failures into messages that say what to do next,
 * mirroring how the SSH tunnel manager explains a missing `ssh` binary. The
 * common case: cloud kubeconfigs (GKE/EKS/AKS) hold no credentials at all —
 * just an exec-plugin reference — so everything here revolves around making
 * plugin failures and 401/403 responses self-explanatory.
 */

interface ExecEntry {
  command?: string;
}

interface AuthProviderEntry {
  name?: string;
  config?: { exec?: ExecEntry };
}

export function authTypeOf(user: User | null | undefined): ClusterAuthType {
  if (!user) return 'none';
  if (user.exec) return 'exec';
  if (user.authProvider) return 'auth-provider';
  if (user.certData || user.certFile) return 'client-cert';
  if (user.token) return 'token';
  if (user.username) return 'basic';
  return 'none';
}

export function execCommandOf(user: User | null | undefined): string | null {
  const exec = (user?.exec ?? (user?.authProvider as AuthProviderEntry | undefined)?.config?.exec) as ExecEntry | undefined;
  return exec?.command ?? null;
}

function authProviderNameOf(user: User | null | undefined): string | null {
  return (user?.authProvider as AuthProviderEntry | undefined)?.name ?? null;
}

/** "gke-gcloud-auth-plugin" from "/usr/lib/.../gke-gcloud-auth-plugin.exe". */
function pluginBaseName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).replace(/\.exe$/i, '');
}

const PLUGIN_INSTALL_HINTS: Record<string, string> = {
  'gke-gcloud-auth-plugin': 'Install it with "gcloud components install gke-gcloud-auth-plugin" (or the google-cloud-cli-gke-gcloud-auth-plugin OS package)',
  aws: 'Install the AWS CLI v2',
  'aws-iam-authenticator': 'Install aws-iam-authenticator (https://github.com/kubernetes-sigs/aws-iam-authenticator)',
  kubelogin: 'Install it with "az aks install-cli"',
  doctl: 'Install the DigitalOcean CLI (doctl)',
  oci: 'Install the Oracle Cloud CLI (oci)',
};

const PLUGIN_RELOGIN_HINTS: Record<string, string> = {
  'gke-gcloud-auth-plugin': 'Run "gcloud auth login" and check the active account with "gcloud auth list"',
  aws: 'Refresh your AWS credentials (e.g. "aws sso login")',
  'aws-iam-authenticator': 'Refresh your AWS credentials',
  kubelogin: 'Run "az login"',
};

export function pluginMissingMessage(command: string): string {
  const base = pluginBaseName(command);
  const hint = PLUGIN_INSTALL_HINTS[base] ?? `Install "${base}"`;
  return (
    `Credential plugin "${command}" was not found on PATH — this kubeconfig entry holds no credentials itself; the plugin mints a token for every connection. ` +
    `${hint} on the machine where the Kubus server runs, then restart Kubus so it picks up the new PATH.`
  );
}

export function legacyAuthProviderWarning(provider: string): string | undefined {
  if (provider === 'gcp') {
    return (
      'This kubeconfig entry uses the legacy "gcp" auth-provider, which kubectl removed in v1.26 — it relies on a cached access token that expires after about an hour. ' +
      'Regenerate the entry with "gcloud container clusters get-credentials" using a current gcloud (it writes a gke-gcloud-auth-plugin exec entry instead).'
    );
  }
  if (provider === 'azure') {
    return (
      'This kubeconfig entry uses the legacy "azure" auth-provider, which kubectl removed in v1.26. ' +
      'Regenerate the entry with "az aks get-credentials" using a current Azure CLI (it writes a kubelogin exec entry instead).'
    );
  }
  return undefined;
}

function canExecute(p: string): boolean {
  try {
    // Windows has no meaningful X bit; existence is the best signal there.
    fs.accessSync(p, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command: string): boolean {
  if (path.isAbsolute(command) || command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return canExecute(command);
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  let names = [command];
  if (process.platform === 'win32') {
    const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    if (!exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()))) {
      names = [command, ...exts.map((e) => command + e)];
    }
  }
  return dirs.some((dir) => names.some((name) => canExecute(path.join(dir, name))));
}

/**
 * PATH lookups are cheap but listContexts runs often; a short TTL also means
 * "install the plugin" is noticed without restarting the server.
 */
const pathLookupCache = new Map<string, { found: boolean; at: number }>();
const PATH_LOOKUP_TTL_MS = 15_000;

export function isCommandOnPath(command: string): boolean {
  const cached = pathLookupCache.get(command);
  if (cached && Date.now() - cached.at < PATH_LOOKUP_TTL_MS) return cached.found;
  const found = findOnPath(command);
  pathLookupCache.set(command, { found, at: Date.now() });
  return found;
}

/**
 * Proactive warning for a kubeconfig user entry: exec plugin missing from
 * PATH, or a legacy auth-provider that modern tooling no longer refreshes.
 */
export function authWarningForUser(user: User | null | undefined): string | undefined {
  const provider = authProviderNameOf(user);
  if (provider) {
    const legacy = legacyAuthProviderWarning(provider);
    if (legacy) return legacy;
  }
  const command = execCommandOf(user);
  if (command && !isCommandOnPath(command)) return pluginMissingMessage(command);
  return undefined;
}

/** The clean API server message of an ApiException, without the "HTTP-Code: …" wrapper. */
function apiDetailOf(err: unknown): string {
  const body = (err as { body?: unknown }).body;
  if (body && typeof body === 'object' && 'message' in body) return String((body as { message: unknown }).message);
  if (err instanceof Error) {
    return /\nMessage: ([^\n]*)/.exec(err.message)?.[1] ?? err.message;
  }
  return '';
}

/** Numeric HTTP status of an ApiException-shaped error, if any. */
export function statusCodeOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  return undefined;
}

/** "user "x" (groups: a, b)" via SelfSubjectReview, or null if unavailable. */
export async function whoAmI(raw: RawClient, timeoutMs = 4_000): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const res = await raw.json<{ status?: { userInfo?: { username?: string; groups?: string[] } } }>('/apis/authentication.k8s.io/v1/selfsubjectreviews', {
      method: 'POST',
      body: JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' }),
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const info = res.status?.userInfo;
    if (!info?.username) return null;
    const groups = (info.groups ?? []).filter((g) => g !== 'system:authenticated');
    if (!groups.length) return `user "${info.username}"`;
    const shown = groups.slice(0, 4).join(', ');
    return `user "${info.username}" (groups: ${shown}${groups.length > 4 ? ', …' : ''})`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function describe401(user: User | null | undefined, authType: ClusterAuthType): string {
  const base = 'The cluster rejected the credentials (401 Unauthorized).';
  const command = execCommandOf(user);
  if (command) {
    const relogin = PLUGIN_RELOGIN_HINTS[pluginBaseName(command)] ?? 'Re-authenticate with the cloud CLI that backs the plugin';
    return `${base} The token minted by credential plugin "${pluginBaseName(command)}" was not accepted — the cloud session behind it may have expired. ${relogin}, on the machine where the Kubus server runs.`;
  }
  const legacy = legacyAuthProviderWarning(authProviderNameOf(user) ?? '');
  if (legacy) return `${base} ${legacy}`;
  switch (authType) {
    case 'token':
      return `${base} The kubeconfig's bearer token was rejected — static tokens from cloud CLIs (e.g. "gcloud auth print-access-token" or "kubectl create token") expire quickly. Paste a fresh one, or switch the entry to the provider's exec plugin or a long-lived ServiceAccount token.`;
    case 'client-cert':
      return `${base} The client TLS credentials were rejected — the cert may have expired or its CA is no longer trusted by the cluster.`;
    case 'none':
      return `${base} This kubeconfig entry has no credentials at all, so the request was anonymous. Cloud clusters (GKE/EKS/AKS) authenticate via an exec plugin — regenerate the entry with the provider's CLI.`;
    default:
      return base;
  }
}

/** True when the error most plausibly came from spawning the exec plugin, not from the network. */
function looksLikeExecFailure(err: Error): boolean {
  if (statusCodeOf(err) !== undefined) return false;
  if (err.name === 'AbortError') return false;
  // node-fetch and TLS/socket errors carry a string `code` (ECONNREFUSED,
  // DEPTH_ZERO_SELF_SIGNED_CERT, …) or a `type`; exec_auth rejects with bare
  // Errors (plugin stderr) or SyntaxError (non-JSON plugin output).
  if ('type' in err || typeof (err as { code?: unknown }).code === 'string') return false;
  return err.name === 'Error' || err.name === 'SyntaxError';
}

const MAX_DETAIL_CHARS = 400;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

/**
 * The health/test-connection error text shown to the user. Never empty:
 * exec plugins that die silently and errors without a message get a
 * descriptive fallback instead of a blank alert.
 */
export async function describeProbeFailure(err: unknown, user: User | null | undefined, raw?: RawClient): Promise<string> {
  const status = statusCodeOf(err);
  if (status === 401) return describe401(user, authTypeOf(user));
  if (status === 403) {
    const detail = clip(apiDetailOf(err));
    // A 403 doesn't guarantee real credentials: entries without any, on an
    // apiserver that allows anonymous requests, are denied as
    // system:anonymous — the fix is the kubeconfig, not RBAC for anonymous.
    if (authTypeOf(user) === 'none') {
      return (
        `The cluster denied the request (403 Forbidden)${detail ? `: ${detail}` : '.'} ` +
        `This kubeconfig entry has no credentials, so the request was anonymous. Cloud clusters (GKE/EKS/AKS) authenticate via an exec plugin — regenerate the entry with the provider's CLI.`
      );
    }
    const identity = raw ? await whoAmI(raw) : null;
    if (identity?.includes('"system:anonymous"')) {
      return `The cluster denied the request (403 Forbidden)${detail ? `: ${detail}` : '.'} The request was treated as anonymous (system:anonymous) — the credentials were not applied at all; check this kubeconfig entry.`;
    }
    let message = `Authenticated, but not authorized (403 Forbidden)${detail ? `: ${detail}` : '.'}`;
    if (identity) message += ` The cluster resolved the credentials to ${identity} — grant that identity the needed RBAC (and cloud IAM) permissions.`;
    else message += ' Check the RBAC (and cloud IAM) permissions of the identity Kubus authenticates as.';
    return message;
  }
  if (err instanceof Error) {
    const command = execCommandOf(user);
    if (command) {
      const syscall = (err as NodeJS.ErrnoException).syscall;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && (!syscall || syscall.startsWith('spawn'))) {
        return pluginMissingMessage(command);
      }
      if (looksLikeExecFailure(err)) {
        const detail = clip(err.message);
        return detail ? `Credential plugin "${pluginBaseName(command)}" failed: ${detail}` : `Credential plugin "${pluginBaseName(command)}" failed without printing an error message.`;
      }
    }
    return clip(err.message) || `connection failed (${err.name || 'no error message'})`;
  }
  return clip(String(err)) || 'connection failed (no error message)';
}
