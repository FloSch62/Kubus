import { PassThrough, type Readable } from 'node:stream';
import type { V1Status } from '@kubernetes/client-node';
import type { ClusterHandle } from './cluster-manager.js';

export interface ExecOutcome {
  code: number;
  stderr: string;
}

const STDERR_CAP = 4096;

function statusToCode(status: V1Status): number {
  if (status.status === 'Success') return 0;
  const msg = status.details?.causes?.find((c) => c.reason === 'ExitCode')?.message;
  return msg ? Number(msg) : 1;
}

function capStderr(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    if (buf.length < STDERR_CAP) buf += chunk.toString('utf8').slice(0, STDERR_CAP - buf.length);
  });
  return { stream, text: () => buf.trim() };
}

/**
 * Run a command in a container without a TTY (binary-safe — TTY mode mangles
 * CR/LF). stdout is discarded unless a sink is given; stdin is optional.
 * Resolves with the exit code and captured stderr.
 */
export async function runCommand(
  handle: ClusterHandle,
  namespace: string,
  pod: string,
  container: string,
  command: string[],
  opts: { stdin?: Readable; stdout?: PassThrough } = {},
): Promise<ExecOutcome> {
  const stderr = capStderr();
  const stdout = opts.stdout ?? new PassThrough();
  if (!opts.stdout) stdout.resume(); // discard
  return new Promise<ExecOutcome>((resolve, reject) => {
    handle
      .makeExec()
      .exec(namespace, pod, container, command, stdout, stderr.stream, (opts.stdin as PassThrough | null) ?? null, false, (status) => {
        resolve({ code: statusToCode(status), stderr: stderr.text() });
      })
      .then((ws) => {
        ws.on('error', (err: Error) => reject(err));
      })
      .catch(reject);
  });
}

export interface CommandStream {
  stdout: PassThrough;
  /** Resolves with the exit outcome once the exec session ends. */
  outcome: Promise<ExecOutcome>;
  stderrText: () => string;
  /** Abort the upstream exec session (e.g. size limit exceeded). */
  abort: () => void;
}

/** Start a command and expose its stdout as a stream for HTTP piping. */
export async function streamCommand(handle: ClusterHandle, namespace: string, pod: string, container: string, command: string[]): Promise<CommandStream> {
  const stdout = new PassThrough();
  const stderr = capStderr();
  let resolveOutcome: (o: ExecOutcome) => void;
  const outcome = new Promise<ExecOutcome>((res) => {
    resolveOutcome = res;
  });
  const ws = await handle.makeExec().exec(namespace, pod, container, command, stdout, stderr.stream, null, false, (status) => {
    resolveOutcome({ code: statusToCode(status), stderr: stderr.text() });
  });
  ws.on('close', () => {
    stdout.end();
    // If the server never sent a status (abnormal close), settle as failure.
    resolveOutcome({ code: 1, stderr: stderr.text() });
  });
  return {
    stdout,
    outcome,
    stderrText: stderr.text,
    abort: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
