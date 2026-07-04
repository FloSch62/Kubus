// Headless runtime smoke test: boot the standalone Kubus server — the same
// backend startServer() the desktop app launches — and confirm it comes up and
// serves the client over HTTP, then shut it down.
//
// Runs in plain Node on every OS with no display, so it catches startup
// regressions (server won't listen, static assets missing, a crash-on-boot)
// that `electron-builder --dir` alone can't — without the flakiness of driving
// a real Electron window in CI.
//
// Requires `pnpm build` first (needs server/dist and client/dist).
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const entry = path.join(repoRoot, 'server', 'dist', 'index.js');

const port = process.env.SMOKE_PORT ?? '3999';
const url = `http://127.0.0.1:${port}/`;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const child = spawn(process.execPath, [entry], {
  cwd: repoRoot,
  // KUBUS_NO_OPEN: don't try to open a browser on a headless runner.
  env: { ...process.env, PORT: port, KUBUS_NO_OPEN: '1', NODE_ENV: 'production' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let settled = false;
function finish(code, msg) {
  if (settled) return;
  settled = true;
  (code === 0 ? console.log : console.error)(msg);
  if (!child.killed) child.kill();
  process.exit(code);
}

// The server should stay up; any exit before we've probed it is a failure.
child.on('exit', (code) => finish(1, `smoke: FAIL — server exited early (code ${code})`));
child.on('error', (err) => finish(1, `smoke: FAIL — could not launch server: ${err.message}`));

const deadline = Date.now() + READY_TIMEOUT_MS;
while (Date.now() < deadline && !settled) {
  try {
    const res = await fetch(url);
    // Any HTTP response means the server is listening and routing. The client
    // shell is served unauthenticated at `/`; only /api routes require a token.
    if (res.ok) finish(0, `smoke: ok — ${url} responded ${res.status}`);
    else finish(1, `smoke: FAIL — ${url} responded ${res.status}`);
  } catch {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

finish(1, `smoke: FAIL — server not ready within ${READY_TIMEOUT_MS}ms`);
