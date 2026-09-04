import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The local shell behind a Terminal dock tab. A real pseudo-terminal is what
 * makes line editing, colours, `kubectl exec -it` and full-screen tools work,
 * so three strategies are tried in order:
 *
 * 1. node-pty when it is installed (an optional native dependency).
 * 2. `script(1)` on Linux and macOS, which allocates a pty around the shell.
 *    Window-size changes are applied with stty on the pty device.
 * 3. Plain pipes — the shell runs, but without a tty. Used on Windows without
 *    node-pty; the tab says so.
 */

export interface ShellProcess {
  /** Whether the shell sits behind a real pseudo-terminal. */
  readonly pty: boolean;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | undefined) => void): void;
}

export interface SpawnShellOptions {
  /** Explicit shell binary; otherwise the user's login shell. */
  shell?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

const LOGIN_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'ksh', 'dash', 'ash', 'tcsh', 'csh']);

/** The shell to run: the caller's choice, else $SHELL, else a sensible platform default. */
export function resolveShell(requested: string | undefined, env: NodeJS.ProcessEnv = process.env, platform = process.platform): { file: string; args: string[] } {
  const wanted = requested?.trim();
  if (platform === 'win32') {
    const file = wanted || findOnPath('pwsh.exe', env) || findOnPath('powershell.exe', env) || env.COMSPEC || 'cmd.exe';
    const base = path.win32.basename(file).toLowerCase();
    return { file, args: base === 'pwsh.exe' || base === 'powershell.exe' ? ['-NoLogo'] : [] };
  }
  const file = wanted || env.SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  const base = path.basename(file);
  return { file, args: LOGIN_SHELLS.has(base) ? ['-l'] : [] };
}

function findOnPath(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

interface NodePtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
  };
}

let nodePtyProbe: Promise<NodePtyModule | undefined> | undefined;

/** node-pty is optional: resolve it once, and remember the answer for the process lifetime. */
function loadNodePty(): Promise<NodePtyModule | undefined> {
  nodePtyProbe ??= import('node-pty' as string)
    .then((mod: unknown) => {
      const candidate = (mod as { default?: unknown }).default ?? mod;
      return typeof (candidate as NodePtyModule).spawn === 'function' ? (candidate as NodePtyModule) : undefined;
    })
    .catch(() => undefined);
  return nodePtyProbe;
}

function withNodePty(pty: NodePtyModule, opts: SpawnShellOptions, shell: { file: string; args: string[] }): ShellProcess {
  const proc = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
  return {
    pty: true,
    write: (data) => proc.write(typeof data === 'string' ? data : data.toString('utf8')),
    resize: (cols, rows) => {
      try {
        proc.resize(Math.max(1, cols), Math.max(1, rows));
      } catch {
        /* resizing a dead pty */
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    onData: (listener) => void proc.onData((data) => listener(Buffer.from(data, 'utf8'))),
    onExit: (listener) => void proc.onExit((event) => listener(event.exitCode)),
  };
}

let scriptProbe: Promise<'util-linux' | 'bsd' | undefined> | undefined;

/** Which `script` flavour is installed — the two take different flags. */
export function detectScript(): Promise<'util-linux' | 'bsd' | undefined> {
  scriptProbe ??= new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve(undefined);
      return;
    }
    execFile('script', ['--version'], { timeout: 3000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err && /util-linux/i.test(`${stdout}${stderr}`)) {
        resolve('util-linux');
        return;
      }
      // BSD script (macOS) has no --version and exits non-zero on it; probe
      // the binary itself instead.
      resolve(fs.existsSync('/usr/bin/script') ? 'bsd' : undefined);
    });
  });
  return scriptProbe;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Find the pty device of the shell `script` started, so stty can resize it. */
async function ptyDeviceOf(scriptPid: number): Promise<string | undefined> {
  const run = (file: string, args: string[]) =>
    new Promise<string>((resolve) => execFile(file, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : stdout)));
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = (await run('pgrep', ['-P', String(scriptPid)])).trim().split(/\s+/).filter(Boolean)[0];
    if (child) {
      const tty = (await run('ps', ['-o', 'tty=', '-p', child])).trim();
      if (tty && tty !== '?' && tty !== '??') return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

function withScript(flavour: 'util-linux' | 'bsd', opts: SpawnShellOptions, shell: { file: string; args: string[] }): ShellProcess {
  const command = [shell.file, ...shell.args].map(shellQuote).join(' ');
  // util-linux: -q quiet, -f flush, -e propagate the exit code, -E never: the
  // pty already echoes input, script's own echo would double every keystroke.
  // BSD (macOS): -q quiet, -F flush; the command follows the transcript file.
  const args = flavour === 'util-linux' ? ['-q', '-f', '-e', '-E', 'never', '-c', command, '/dev/null'] : ['-q', '-F', '/dev/null', shell.file, ...shell.args];
  const child = spawn('script', args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const device = ptyDeviceOf(child.pid ?? -1);
  const sttyFlag = process.platform === 'darwin' ? '-f' : '-F';
  const resize = (cols: number, rows: number) => {
    void device.then((dev) => {
      if (!dev) return;
      execFile('stty', [sttyFlag, dev, 'rows', String(Math.max(1, rows)), 'cols', String(Math.max(1, cols))], { timeout: 2000 }, () => {});
    });
  };
  resize(opts.cols, opts.rows);
  return pipeProcess(child, true, resize);
}

function withPipes(opts: SpawnShellOptions, shell: { file: string; args: string[] }): ShellProcess {
  const args = process.platform === 'win32' ? shell.args : shell.args.filter((a) => a !== '-l').concat(['-i']);
  const child = spawn(shell.file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return pipeProcess(child, false);
}

function pipeProcess(child: ChildProcess, pty: boolean, resize?: (cols: number, rows: number) => void): ShellProcess {
  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const exitListeners: Array<(code: number | undefined) => void> = [];
  const forward = (chunk: Buffer) => {
    for (const listener of dataListeners) listener(chunk);
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  child.on('error', (err) => forward(Buffer.from(`\r\n[kubus] could not start the shell: ${err.message}\r\n`)));
  child.on('exit', (code) => {
    for (const listener of exitListeners) listener(code ?? undefined);
  });
  return {
    pty,
    write: (data) => {
      if (child.stdin?.writable) child.stdin.write(data);
    },
    resize: (cols, rows) => resize?.(cols, rows),
    kill: () => {
      try {
        child.kill('SIGHUP');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2000).unref();
      } catch {
        /* already gone */
      }
    },
    onData: (listener) => void dataListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
  };
}

/** Start the user's shell, preferring a real pseudo-terminal. */
export async function spawnShell(opts: SpawnShellOptions): Promise<ShellProcess> {
  const shell = resolveShell(opts.shell, opts.env, process.platform);
  const env = { ...opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const nodePty = await loadNodePty();
  if (nodePty) return withNodePty(nodePty, { ...opts, env }, shell);
  const script = await detectScript();
  if (script) return withScript(script, { ...opts, env }, shell);
  return withPipes({ ...opts, env }, shell);
}

/** Working directory for a fresh shell: the user's home, or the temp dir if that is missing. */
export function defaultShellCwd(): string {
  const home = os.homedir();
  return home && fs.existsSync(home) ? home : os.tmpdir();
}
