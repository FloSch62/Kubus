import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { claimInstance } from '../../../desktop/src/instance.js';

// Vitest runs in Node. The subprocess test below exercises the real Bun FFI lock.
vi.mock('../../../desktop/src/instance-lock.js', () => {
  const held = new Set<string>();
  return { tryInstanceLock: (file: string) => {
    if (held.has(file)) return undefined;
    held.add(file);
    return () => held.delete(file);
  } };
});

function socketAddress(dir: string): string {
  const id = createHash('sha256').update(dir).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\kubus-${id}` : path.join(tmpdir(), `kubus-${process.getuid?.() ?? 'user'}-${id}.sock`);
}

it('hands subsequent launches to the owning instance and releases ownership on exit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubus-instance-test-'));
  const activate = vi.fn();
  const first = await claimInstance(dir, undefined, activate);
  try {
    expect(first).toBeDefined();
    expect(await claimInstance(dir, 'kubus://r/core/v1/pods', vi.fn())).toBeUndefined();
    expect(activate).toHaveBeenCalledWith('kubus://r/core/v1/pods');
    await new Promise<void>((resolve) => first!.close(() => resolve()));
    const next = await claimInstance(dir, undefined, vi.fn());
    await new Promise<void>((resolve) => next!.close(() => resolve()));
  } finally { first?.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('claims ownership when the previous peer closes without acknowledging the launch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubus-instance-test-'));
  const peer = createServer({ allowHalfOpen: true }, (socket) => {
    peer.close();
    socket.end();
    socket.resume();
  });
  let next: Server | undefined;
  try {
    await new Promise<void>((resolve) => peer.listen(socketAddress(dir), resolve));
    next = await claimInstance(dir, undefined, vi.fn());
    expect(next?.listening).toBe(true);
  } finally { peer.close(); next?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 5000);

it('keeps the forwarding connection open until the owner acknowledges the launch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubus-instance-test-'));
  let endedBeforeReply: boolean | undefined;
  const peer = createServer({ allowHalfOpen: true }, (socket) => {
    socket.once('data', () => {
      setTimeout(() => {
        endedBeforeReply = socket.readableEnded;
        socket.end('ok');
      }, 25);
    });
  });
  try {
    await new Promise<void>((resolve) => peer.listen(socketAddress(dir), resolve));
    expect(await claimInstance(dir, 'kubus://r/core/v1/pods', vi.fn())).toBeUndefined();
    expect(endedBeforeReply).toBe(false);
  } finally { peer.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('keeps a live socket when its peer closes connections without acknowledging them', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubus-instance-test-'));
  const peer = createServer({ allowHalfOpen: true }, (socket) => { socket.end(); socket.resume(); });
  try {
    await new Promise<void>((resolve) => peer.listen(socketAddress(dir), resolve));
    await expect(claimInstance(dir, undefined, vi.fn())).rejects.toThrow('did not respond');
    expect(peer.listening).toBe(true);
    peer.removeAllListeners('connection');
    peer.on('connection', (socket) => { socket.end('ok'); socket.resume(); });
    expect(await claimInstance(dir, undefined, vi.fn())).toBeUndefined();
  } finally { peer.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('elects one Bun process after a crash leaves a stale socket, then releases ownership on exit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubus-instance-test-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux';
  const bundle = process.platform === 'darwin' ? 'Kubus-dev.app/Contents/MacOS' : 'Kubus-dev/bin';
  const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  let bun = process.env.KUBUS_TEST_BUN ?? path.join(root, 'desktop/build', `dev-${platform}-${process.arch}`, bundle, binary);
  if (!process.env.KUBUS_TEST_BUN && !existsSync(bun)) {
    const dependencies = JSON.parse(readFileSync(path.join(root, 'desktop/.hutch/dependencies.lock'), 'utf8')) as { objects: Array<{ toolchain?: string; relativeRoot: string }> };
    const runtime = dependencies.objects.find((object) => object.toolchain === 'bun');
    if (runtime) bun = path.join(homedir(), '.hutch', runtime.relativeRoot, binary);
  }
  expect(existsSync(bun), 'Run desktop prepare:sdk or set KUBUS_TEST_BUN to its Bun runtime.').toBe(true);
  const fixture = fileURLToPath(new URL('../../desktop/fixtures/instance-process.ts', import.meta.url));
  const children: Array<ReturnType<typeof launch>> = [];
  function launch(): { child: ChildProcessWithoutNullStreams; exit: Promise<unknown[]>; output: () => string; errors: () => string } {
    const child = spawn(bun, [fixture, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    const exit = once(child, 'exit');
    void exit.catch((error: unknown) => { errors += String(error); });
    const result = { child, exit, output: () => output, errors: () => errors };
    children.push(result);
    return result;
  }
  try {
    const crashed = launch();
    crashed.child.stdin.write('claim\n');
    await vi.waitFor(() => expect(crashed.output(), crashed.errors()).toContain('owner'), { timeout: 10_000 });
    crashed.child.kill('SIGKILL');
    await crashed.exit;

    const contenders = Array.from({ length: 8 }, launch);
    // Hold every process at the same barrier so they race over the stale socket.
    await vi.waitFor(() => expect(contenders.every((p) => p.output().includes('ready'))).toBe(true), { timeout: 10_000 });
    for (const contender of contenders) contender.child.stdin.write('claim\n');
    await vi.waitFor(() => expect(contenders.every((p) => /owner|forwarded/.test(p.output())), contenders.map((p) => p.errors()).join('\n')).toBe(true), { timeout: 10_000 });
    const owners = contenders.filter((p) => p.output().includes('owner'));
    expect(owners).toHaveLength(1);
    await vi.waitFor(() => expect(owners[0]!.output().match(/activate/g)).toHaveLength(7));
    for (const contender of contenders.filter((p) => !owners.includes(p))) expect((await contender.exit)[0]).toBe(0);
    owners[0]!.child.stdin.end();
    expect((await owners[0]!.exit)[0]).toBe(0);

    const next = launch();
    next.child.stdin.write('claim\n');
    await vi.waitFor(() => expect(next.output(), next.errors()).toContain('owner'), { timeout: 10_000 });
    next.child.stdin.end();
    expect((await next.exit)[0]).toBe(0);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map((p) => p.exit));
    if (process.platform !== 'win32') {
      rmSync(socketAddress(dir), { force: true });
      rmSync(`${socketAddress(dir)}.lock`, { force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
