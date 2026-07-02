import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { SettingsStore } from '../settings-store.js';

/**
 * Kubus-managed SSH tunnels: for contexts mapped to a jump host we spawn the
 * user's own OpenSSH client (`ssh -N -D 127.0.0.1:<port> <host>`) and route the
 * cluster's traffic through the resulting SOCKS listener. Using the system ssh
 * — not an SSH library — means the user's ~/.ssh/config (ProxyJump chains,
 * identities, agent, per-host options) applies exactly as it does in a terminal.
 *
 * The context→host mapping lives in Kubus settings, never in the kubeconfig,
 * so the kubeconfig stays kubectl-compatible.
 */

const READY_TIMEOUT_MS = 25_000;
/** After a failed start, don't respawn for this long — background health probes retry every 60s. */
const FAILURE_HOLDOFF_MS = 20_000;
const STDERR_KEEP_LINES = 12;

/** SSH destinations we accept: an ssh_config alias, [user@]host or ssh://user@host:port — no options smuggling. */
const SSH_DESTINATION_RE = /^(ssh:\/\/)?[A-Za-z0-9][A-Za-z0-9._~%@:\[\]-]*$/;

export function isValidSshDestination(dest: string): boolean {
  return dest.length > 0 && dest.length <= 256 && SSH_DESTINATION_RE.test(dest);
}

interface Tunnel {
  host: string;
  /** Local SOCKS port; kept across restarts so runtime proxy URLs stay stable. */
  port?: number;
  child?: ChildProcess;
  up: boolean;
  stderrTail: string[];
  lastError?: string;
  failedAt?: number;
  /** In-flight start, so concurrent ensure() calls share one spawn. */
  starting?: Promise<number>;
}

export class SshTunnelManager {
  /** Scoped kubeconfig context key -> ssh destination. */
  private mapping: Record<string, string>;
  private tunnels = new Map<string, Tunnel>();
  private sshBinaryInfo?: { path: string | null; version?: string };
  private disposed = false;

  constructor(
    private log: FastifyBaseLogger,
    private settings: SettingsStore,
  ) {
    const loaded = settings.load().sshTunnels ?? {};
    this.mapping = Object.fromEntries(Object.entries(loaded).filter(([key]) => key.startsWith('context:')));
    // ssh children have their own keepalive and outlive us unless killed. The
    // fastify onClose hook covers graceful shutdown; these cover everything
    // else (Ctrl-C, SIGTERM from a dev watcher or service manager).
    const shutdown = () => this.stopAll();
    process.once('exit', shutdown);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        shutdown();
        // Re-raise so the default exit behavior (and exit code) is preserved.
        process.kill(process.pid, signal);
      });
    }
  }

  hostForContextKey(contextKey: string): string | undefined {
    return this.mapping[contextKey];
  }

  /** Update the context→host mapping, persist it, and stop tunnels nothing references anymore. */
  setHostForContextKey(contextKey: string, host: string | null): void {
    if (host) this.mapping[contextKey] = host;
    else delete this.mapping[contextKey];
    this.settings.save({ sshTunnels: { ...this.mapping } });
    const referenced = new Set(Object.values(this.mapping));
    for (const [tunnelHost, tunnel] of this.tunnels) {
      if (!referenced.has(tunnelHost)) {
        this.stopTunnel(tunnel);
        this.tunnels.delete(tunnelHost);
      }
    }
  }

  /**
   * Make sure a tunnel to `host` is up and return its SOCKS proxy URL.
   * Throws with a user-actionable message when ssh is missing or the tunnel
   * can't be established.
   */
  async ensure(host: string): Promise<string> {
    if (!isValidSshDestination(host)) throw new Error(`invalid SSH destination "${host}"`);
    const existing = this.tunnels.get(host);
    const tunnel: Tunnel = existing ?? { host, up: false, stderrTail: [] };
    if (!existing) this.tunnels.set(host, tunnel);
    if (tunnel.up && tunnel.child && tunnel.child.exitCode === null && tunnel.port) {
      return socksUrl(tunnel.port);
    }
    if (!tunnel.starting) {
      if (tunnel.failedAt && Date.now() - tunnel.failedAt < FAILURE_HOLDOFF_MS) {
        throw new Error(tunnel.lastError ?? `SSH tunnel via "${host}" failed recently; retrying shortly`);
      }
      tunnel.starting = this.start(tunnel).finally(() => {
        tunnel.starting = undefined;
      });
    }
    const port = await tunnel.starting;
    return socksUrl(port);
  }

  /** Availability of the OpenSSH client on this machine (probed once). */
  async binaryInfo(): Promise<{ available: boolean; version?: string }> {
    const info = await this.detectSsh();
    return { available: info.path !== null, version: info.version };
  }

  /** Tunnel state for a mapped context, for surfacing in the context list. */
  tunnelStateForContextKey(contextKey: string): 'up' | 'starting' | 'down' | 'error' | undefined {
    const host = this.mapping[contextKey];
    if (!host) return undefined;
    const tunnel = this.tunnels.get(host);
    if (!tunnel) return 'down';
    if (tunnel.up && tunnel.child && tunnel.child.exitCode === null) return 'up';
    if (tunnel.starting) return 'starting';
    return tunnel.lastError ? 'error' : 'down';
  }

  stopAll(): void {
    this.disposed = true;
    for (const tunnel of this.tunnels.values()) this.stopTunnel(tunnel);
    this.tunnels.clear();
  }

  private stopTunnel(tunnel: Tunnel): void {
    tunnel.up = false;
    if (tunnel.child && tunnel.child.exitCode === null) {
      tunnel.child.removeAllListeners('exit');
      tunnel.child.kill();
    }
    tunnel.child = undefined;
  }

  private async start(tunnel: Tunnel): Promise<number> {
    const ssh = await this.requireSsh();
    // Reuse the previous port when possible so proxy URLs baked into live
    // clients survive a tunnel restart; fall back to a fresh port if it's taken.
    let port = tunnel.port ?? (await findFreePort());
    for (let attempt = 0; ; attempt++) {
      try {
        await this.spawnAndAwaitReady(ssh, tunnel, port);
        tunnel.port = port;
        tunnel.up = true;
        tunnel.failedAt = undefined;
        tunnel.lastError = undefined;
        this.log.info({ host: tunnel.host, port }, 'ssh tunnel established');
        return port;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && /local SOCKS port .* is already in use/i.test(message)) {
          port = await findFreePort();
          continue;
        }
        tunnel.failedAt = Date.now();
        tunnel.lastError = message;
        this.log.warn({ host: tunnel.host, err: message }, 'ssh tunnel failed to start');
        throw err instanceof Error ? err : new Error(message);
      }
    }
  }

  private spawnAndAwaitReady(ssh: string, tunnel: Tunnel, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      tunnel.stderrTail = [];
      // No ExitOnForwardFailure: the user's ssh config may declare its own
      // forwardings for this host (e.g. `DynamicForward 8888` they used for the
      // manual-SOCKS workflow), and a collision on those must not kill the
      // tunnel — our own -D port is what matters, and we watch it ourselves:
      // readiness comes from connecting to it, and a bind failure on exactly
      // our port is detected on stderr below (→ retry on a fresh port).
      // ClearAllForwardings is no alternative: it strips command-line -D too.
      const args = [
        '-N', // tunnel only, no remote command
        '-o', 'BatchMode=yes', // never hang on an interactive prompt — fail with a message instead
        '-o', 'StrictHostKeyChecking=accept-new', // first contact OK, changed keys still refused
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-D', `127.0.0.1:${port}`,
        '--',
        tunnel.host,
      ];
      const child = spawn(ssh, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      tunnel.child = child;
      let settled = false;

      // "bind [127.0.0.1]:<port>: Address already in use" names the port, so we
      // can tell a fatal collision on our SOCKS port from an ignorable one on a
      // forwarding the user's config declares for this host.
      const ourPortBindError = new RegExp(`(bind|listen)[^\\n]*[:.]${port}\\b[^\\n]*(already in use|failure|failed)|Address already in use[^\\n]*:${port}\\b`, 'i');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.trim()) continue;
          tunnel.stderrTail.push(line.trim());
          if (tunnel.stderrTail.length > STDERR_KEEP_LINES) tunnel.stderrTail.shift();
          if (ourPortBindError.test(line)) {
            finish(new Error(`local SOCKS port ${port} is already in use`));
          }
        }
      });

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(deadline);
        if (err) {
          if (child.exitCode === null) child.kill();
          reject(err);
        } else {
          resolve();
        }
      };

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(new Error(err.code === 'ENOENT' ? sshMissingMessage() : `failed to run ssh: ${err.message}`));
      });

      child.on('exit', (code) => {
        const wasUp = tunnel.up;
        tunnel.up = false;
        if (!settled) {
          finish(new Error(friendlyStartError(tunnel.host, code, tunnel.stderrTail)));
          return;
        }
        // Died after being ready (laptop sleep, network change, bastion restart):
        // the next ensure() — e.g. the 60s background health probe — respawns it.
        if (wasUp && !this.disposed) {
          this.log.warn({ host: tunnel.host, code, stderr: tunnel.stderrTail.join(' | ') }, 'ssh tunnel exited; will respawn on next use');
        }
      });

      // ssh opens the -D listener only after authentication succeeds, so a
      // successful local connect means the tunnel is genuinely usable.
      const pollTimer = setInterval(() => {
        if (child.exitCode !== null) return; // exit handler owns the failure
        const probe = net.connect({ host: '127.0.0.1', port });
        probe.once('connect', () => {
          probe.destroy();
          finish();
        });
        probe.once('error', () => probe.destroy());
      }, 250);
      pollTimer.unref();

      const deadline = setTimeout(() => {
        finish(new Error(`timed out after ${READY_TIMEOUT_MS / 1000}s waiting for the SSH tunnel via "${tunnel.host}" to open${stderrSuffix(tunnel.stderrTail)}`));
      }, READY_TIMEOUT_MS);
      deadline.unref();
    });
  }

  private async requireSsh(): Promise<string> {
    const info = await this.detectSsh();
    if (!info.path) throw new Error(sshMissingMessage());
    return info.path;
  }

  private async detectSsh(): Promise<{ path: string | null; version?: string }> {
    if (this.sshBinaryInfo) return this.sshBinaryInfo;
    const candidates = ['ssh'];
    if (process.platform === 'win32') {
      // Not on PATH for some setups even though the optional feature is installed.
      candidates.push(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'));
    } else {
      candidates.push('/usr/bin/ssh');
    }
    for (const candidate of candidates) {
      const version = await probeSshVersion(candidate);
      if (version !== null) {
        this.sshBinaryInfo = { path: candidate, version: version || undefined };
        return this.sshBinaryInfo;
      }
    }
    this.sshBinaryInfo = { path: null };
    return this.sshBinaryInfo;
  }
}

function socksUrl(port: number): string {
  // socks5h: hostnames resolve on the jump host — API servers behind it usually
  // aren't resolvable locally, and TLS names must match what the cluster expects.
  return `socks5h://127.0.0.1:${port}`;
}

/** Run `<candidate> -V`; resolves the version banner, empty string if unparsable, null if not runnable. */
function probeSshVersion(candidate: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(candidate, ['-V'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      resolve(/OpenSSH_[^,\s]*/.exec(stderr)?.[0] ?? '');
    });
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill();
        resolve(null);
      }
    }, 5_000).unref();
  });
}

function sshMissingMessage(): string {
  const base = 'OpenSSH client (ssh) not found on this machine.';
  switch (process.platform) {
    case 'win32':
      return `${base} Install it via Settings → System → Optional features → "OpenSSH Client", then restart Kubus.`;
    case 'darwin':
      return `${base} macOS ships it at /usr/bin/ssh — check that it hasn't been removed by device management.`;
    default:
      return `${base} Install your distribution's OpenSSH client package (e.g. "sudo apt install openssh-client").`;
  }
}

function stderrSuffix(tail: string[]): string {
  const meaningful = tail.filter((l) => !/^Warning: Permanently added/i.test(l));
  return meaningful.length ? ` — ssh said: ${meaningful.slice(-3).join(' | ')}` : '';
}

/** Turn ssh's stderr into something a user can act on. */
function friendlyStartError(host: string, exitCode: number | null, tail: string[]): string {
  const raw = tail.join(' ');
  if (/permission denied|no supported authentication|too many authentication failures/i.test(raw)) {
    return `SSH authentication to "${host}" failed. Kubus runs ssh non-interactively — make sure "ssh ${host}" works in a terminal without typing a password (load your key into ssh-agent, or use a key without a passphrase)${stderrSuffix(tail)}`;
  }
  if (/host key verification failed|remote host identification has changed/i.test(raw)) {
    return `Host key verification for "${host}" failed. Run "ssh ${host}" once in a terminal to review and accept the host key, then try again${stderrSuffix(tail)}`;
  }
  if (/could not resolve hostname|name or service not known/i.test(raw)) {
    return `Could not resolve "${host}". Check the host name (or your ~/.ssh/config entry) and that you're on the right network/VPN${stderrSuffix(tail)}`;
  }
  if (/connection refused|connection timed out|network is unreachable|operation timed out/i.test(raw)) {
    return `Could not reach "${host}". Check that the jump host is up and reachable from this machine${stderrSuffix(tail)}`;
  }
  return `SSH tunnel via "${host}" exited${exitCode !== null ? ` (code ${exitCode})` : ''}${stderrSuffix(tail)}`;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
