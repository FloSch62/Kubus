import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { RequestOptions } from 'node:https';
import type { KubeConfig, User } from '@kubernetes/client-node';
import type { Authenticator } from '@kubernetes/client-node/dist/auth.js';
import { HttpProblem } from '../util/errors.js';

export const EXEC_AUTH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface ExecConfig {
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  apiVersion?: string;
  interactiveMode?: string;
  provideClusterInfo?: boolean;
}

interface Credential {
  token?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
  expirationTimestamp?: string;
}

interface Session {
  exec: ExecConfig;
  env: NodeJS.ProcessEnv;
  credential?: Credential;
  pending?: Promise<Credential>;
  error?: ExecCredentialError;
  cancel?: () => void;
  retired?: boolean;
}

export class ExecCredentialError extends HttpProblem {
  constructor(command: string | undefined, detail: string) {
    const name = command?.split(/[\\/]/).pop() || 'unknown';
    super(401, `Credential plugin "${name}" failed: ${detail.trim().slice(0, 400) || 'no error message'}. Automatic authentication is paused. Sign in with your cloud CLI, then use Reconnect or Test connection to retry.`, 'AuthenticationRequired');
    this.name = 'ExecCredentialError';
  }
}

function execConfig(user: User | null): ExecConfig | undefined {
  return (user?.exec ?? (user?.authProvider as { config?: { exec?: ExecConfig } } | undefined)?.config?.exec) as ExecConfig | undefined;
}

function parseCredential(stdout: string, apiVersion: string): Credential {
  let result: { apiVersion?: string; kind?: string; status?: Credential };
  try {
    result = JSON.parse(stdout) as typeof result;
  } catch {
    // JSON parser errors can quote stdout, which may contain a credential.
    throw new Error('the plugin returned invalid JSON');
  }
  if (result?.apiVersion !== apiVersion || result.kind !== 'ExecCredential' || !result.status) {
    throw new Error('the plugin did not return a matching ExecCredential');
  }
  const status = result.status;
  for (const key of ['token', 'clientCertificateData', 'clientKeyData', 'expirationTimestamp'] as const) {
    if (status[key] !== undefined && typeof status[key] !== 'string') throw new Error(`invalid credential ${key}`);
  }
  if (!!status.clientCertificateData !== !!status.clientKeyData) throw new Error('the plugin must return both a client certificate and key');
  if (!status.token && !status.clientCertificateData) throw new Error('the plugin returned no token or client certificate');
  if (status.expirationTimestamp && !(Date.parse(status.expirationTimestamp) > Date.now())) {
    throw new Error('the plugin returned an expired or invalid expiration timestamp');
  }
  return status;
}

/**
 * One credential refresh per effective exec configuration across cluster handles
 * and health probes. Failures stay paused across background retries and config
 * reloads; only an explicit retry clears them. Resource deadlines do not own the
 * shared child process: it has its own deadline and is terminated on shutdown.
 */
export class ExecCredentialManager {
  private sessions = new Map<string, Session>();
  private contexts = new Map<string, Session>();
  private disposed = false;

  constructor(private timeoutMs = EXEC_AUTH_TIMEOUT_MS) {}

  attach(kc: KubeConfig): () => void {
    if (this.disposed) throw new HttpProblem(409, 'The cluster session is closed', 'NotConnected');
    const user = kc.getCurrentUser();
    const config = execConfig(user);
    if (!config || !user) return () => {};
    const exec = structuredClone(config);
    const apiVersion = exec.apiVersion ?? 'client.authentication.k8s.io/v1beta1';
    const cluster = kc.getCurrentCluster();
    const clusterInfo = exec.provideClusterInfo && cluster ? {
      server: cluster.server,
      'tls-server-name': cluster.tlsServerName,
      'insecure-skip-tls-verify': cluster.skipTLSVerify,
      'certificate-authority-data': cluster.caData ?? (cluster.caFile ? fs.readFileSync(cluster.caFile).toString('base64') : undefined),
      'proxy-url': cluster.proxyUrl,
    } : undefined;
    const env = { ...process.env };
    for (const entry of exec.env ?? []) env[entry.name] = entry.value;
    env.KUBERNETES_EXEC_INFO = JSON.stringify({ apiVersion, kind: 'ExecCredential', spec: { interactive: false, cluster: clusterInfo } });
    // Never key by username or executable alone: profiles, environment and
    // cluster input can all change which identity the plugin returns.
    const key = createHash('sha256').update(JSON.stringify([
      exec.command, exec.args ?? [], exec.interactiveMode ?? 'IfAvailable', process.cwd(),
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    ])).digest('hex');
    let session = this.sessions.get(key);
    if (!session) {
      session = { exec: { ...exec, apiVersion }, env };
      this.sessions.set(key, session);
    }
    this.contexts.set(kc.getCurrentContext(), session);
    const bound = session;
    let active = true;
    const assertActive = () => {
      if (!active || this.disposed) throw new HttpProblem(409, 'The cluster session is closed', 'NotConnected');
    };
    const authenticator: Authenticator = {
      isAuthProvider: (candidate) => candidate === user,
      applyAuthentication: async (_user, options) => {
        assertActive();
        const credential = await this.getCredential(bound);
        assertActive();
        const opts = options as RequestOptions;
        if (credential.token) {
          opts.headers ??= {};
          (opts.headers as Record<string, string>).Authorization = `Bearer ${credential.token}`;
        }
        if (credential.clientCertificateData) opts.cert = credential.clientCertificateData;
        if (credential.clientKeyData) opts.key = credential.clientKeyData;
      },
    };
    // client-node's public addAuthenticator() only appends fallbacks, so its
    // built-in ExecAuth would still win. Keep the private integration in this
    // one adapter and exercise both public authentication APIs in tests.
    const { authenticators } = kc as unknown as { authenticators: Authenticator[] };
    const index = authenticators.findIndex((entry) => entry.isAuthProvider(user));
    if (index < 0) throw new Error('Kubernetes exec authenticator is unavailable');
    authenticators[index] = authenticator;
    return () => { active = false; };
  }

  /** Reconnect/Test connection may retry a failure, but never overlap a running login. */
  retry(contextName: string): void {
    const session = this.contexts.get(contextName);
    if (!session || session.pending) return;
    session.error = undefined;
    session.credential = undefined;
  }

  retainContexts(names: Set<string>): void {
    for (const name of this.contexts.keys()) if (!names.has(name)) this.contexts.delete(name);
    const retained = new Set(this.contexts.values());
    for (const [key, session] of this.sessions) {
      if (retained.has(session)) continue;
      session.retired = true;
      session.cancel?.();
      this.sessions.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.retired = true;
      session.cancel?.();
    }
    this.sessions.clear();
    this.contexts.clear();
  }

  private getCredential(session: Session): Promise<Credential> {
    if (session.retired) return Promise.reject(new HttpProblem(409, 'The cluster session is closed', 'NotConnected'));
    if (session.pending) return session.pending;
    if (session.error) return Promise.reject(session.error);
    const credential = session.credential;
    if (credential && (!credential.expirationTimestamp || Date.parse(credential.expirationTimestamp) > Date.now())) {
      return Promise.resolve(credential);
    }
    session.credential = undefined;
    // Publish the promise before spawning so every caller shares successes
    // and failures, including synchronous spawn/configuration errors.
    session.pending = Promise.resolve().then(() => this.run(session)).then((next) => {
      session.credential = next;
      return next;
    }).catch((err: unknown) => {
      session.error = new ExecCredentialError(session.exec.command, err instanceof Error ? err.message : String(err));
      throw session.error;
    }).finally(() => {
      session.pending = undefined;
    });
    return session.pending;
  }

  private run(session: Session): Promise<Credential> {
    if (this.disposed || session.retired) throw new Error('authentication was cancelled');
    const { exec, env } = session;
    if (!exec.command) throw new Error('no credential command was configured');
    if (exec.interactiveMode === 'Always') throw new Error('the plugin requires a terminal; authenticate with your cloud CLI first');
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(exec.command, exec.args ?? [], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let failure: Error | undefined;
      const stop = (message: string) => {
        if (failure) return;
        failure = new Error(message);
        // Own a process group on POSIX so wrappers cannot leave a CLI child
        // behind. On Windows taskkill /T terminates the equivalent tree.
        if (child.pid && process.platform === 'win32') {
          const killer = childProcess.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => { child.kill('SIGKILL'); });
          killer.on('close', (code) => { if (code !== 0) child.kill('SIGKILL'); });
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      };
      session.cancel = () => stop('authentication was cancelled');
      const timer = setTimeout(() => stop(`authentication timed out after ${this.timeoutMs / 1000}s`), this.timeoutMs);
      timer.unref();
      const collect = (chunk: string, output: 'stdout' | 'stderr') => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) { stop('credential plugin output exceeded 1 MiB'); return; }
        if (output === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => collect(chunk, 'stdout'));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => collect(chunk, 'stderr'));
      child.on('error', (err) => { failure ??= err; });
      child.on('close', (code) => {
        clearTimeout(timer);
        session.cancel = undefined;
        // Keep the shared attempt locked until the process has actually closed.
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error(stderr.trim() || `exited with code ${code}`)); return; }
        try { resolve(parseCredential(stdout, exec.apiVersion!)); } catch (err) { reject(err); }
      });
    });
  }
}
