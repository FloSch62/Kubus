// Real AppImage updates against localhost: no GitHub release, credentials, or
// installed Kubus profile is used. Run after pnpm build && pnpm build:helm-engine.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Arch, build, Platform } from 'electron-builder';
import { _electron as electron } from 'playwright-core';

assert.equal(process.platform, 'linux', 'This integration test requires Linux and tests the AppImage updater.');
const projectDir = path.resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'kubus-updater-'));
const installed = path.join(scratch, 'Kubus.AppImage');
const userData = path.join(scratch, 'user-data');
const kubeconfig = path.join(scratch, 'kubeconfig');
const { version: currentVersion } = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
const [major, minor, patch] = currentVersion.split('.').map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;
let manifest;
let candidate;
let app;
let payloadRequests = 0;

const feed = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/latest-linux.yml' && manifest) {
    response.writeHead(200, { 'Content-Type': 'application/yaml', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(manifest)); // JSON is valid YAML.
  } else if (pathname === '/update.AppImage' && candidate) {
    // Deliberately support only full downloads, also exercising the updater's
    // fallback when a provider does not support differential downloads.
    payloadRequests++;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': manifest.files[0].size });
    createReadStream(candidate).pipe(response);
  } else {
    response.writeHead(404);
    response.end();
  }
});

async function hash(file) {
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('base64');
}

async function packageVersion(version) {
  const output = path.join(scratch, `build-${version}`);
  await build({
    projectDir,
    targets: Platform.LINUX.createTarget('AppImage', Arch.x64),
    publish: 'never',
    config: {
      extends: path.join(projectDir, 'electron-builder.yml'),
      directories: { output },
      extraMetadata: { version },
      publish: [{ provider: 'generic', url: `http://127.0.0.1:${feed.address().port}`, useMultipleRangeRequest: false }],
    },
  });
  const files = (await readdir(output)).filter((file) => file.endsWith('.AppImage'));
  assert.equal(files.length, 1);
  return path.join(output, files[0]);
}

async function launch() {
  app = await electron.launch({
    executablePath: installed,
    args: ['--no-sandbox', ...(process.env.DISPLAY ? [] : ['--headless', '--disable-gpu']), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: '1',
      TMPDIR: scratch,
      XDG_CONFIG_HOME: path.join(scratch, 'config'),
      XDG_CACHE_HOME: path.join(scratch, 'cache'),
      KUBECONFIG: kubeconfig,
      KUBUS_NO_OPEN: '1',
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.kubusDesktop);
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.isPackaged), true);
  return page;
}

try {
  feed.listen(0, '127.0.0.1');
  await once(feed, 'listening');
  await mkdir(userData, { recursive: true });
  await writeFile(kubeconfig, JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [], contexts: [], users: [], 'current-context': '' }));
  const baseline = await packageVersion(currentVersion);
  candidate = await packageVersion(nextVersion);
  await copyFile(baseline, installed);
  await chmod(installed, 0o755);
  const candidateHash = await hash(candidate);
  const size = (await stat(candidate)).size;
  const makeManifest = (version, sha512) => ({ version, files: [{ url: 'update.AppImage', sha512, size }], path: 'update.AppImage', sha512 });
  manifest = makeManifest(currentVersion, candidateHash);

  let page = await launch();
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.getVersion()), currentVersion);
  await page.evaluate(() => {
    window.updaterTestStates = [];
    window.kubusDesktop.onUpdateState((state) => window.updaterTestStates.push(state));
  });
  assert.equal((await page.evaluate(() => window.kubusDesktop.checkForUpdates())).status, 'up-to-date');
  assert.equal(payloadRequests, 0, 'No payload should download for the installed version');
  console.log('PASS: packaged app checks localhost and reports the installed version as up to date');

  manifest = makeManifest(nextVersion, Buffer.alloc(64).toString('base64'));
  assert.equal((await page.evaluate(() => window.kubusDesktop.checkForUpdates())).status, 'error');
  assert.match(await readFile(path.join(userData, 'logs/main.log'), 'utf8'), /sha512 checksum mismatch/);
  assert.equal(await hash(installed), await hash(baseline), 'Invalid download must not replace the installed app');
  console.log('PASS: real electron-updater rejects a corrupted checksum and preserves the installed app');

  manifest = makeManifest(nextVersion, candidateHash);
  const ready = await page.evaluate(() => window.kubusDesktop.checkForUpdates());
  assert.equal(ready.status, 'ready');
  assert.equal(ready.version, nextVersion);
  assert.equal(ready.percent, 100);
  const states = await page.evaluate(() => window.updaterTestStates);
  for (const status of ['checking', 'up-to-date', 'downloading', 'error', 'ready']) {
    assert(states.some((state) => state.status === status), `Renderer must receive ${status}`);
  }
  await page.getByRole('button', { name: 'Restart to update' }).first().waitFor();
  console.log('PASS: retry downloads the valid update, broadcasts progress, and displays Restart to update');

  await page.evaluate(() => window.kubusDesktop.stateStorage.setItem('updater-integration', 'preserved'));
  // A normal quit exercises autoInstallOnAppQuit without spawning an untracked
  // GUI process. Reopen the installed file ourselves to inspect its version.
  await app.close();
  app = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await hash(installed).catch(() => '') === candidateHash) break;
    await delay(100);
  }
  assert.equal(await hash(installed), candidateHash, 'Quitting must replace the AppImage with the verified payload');
  const downloadsBeforeRelaunch = payloadRequests;
  page = await launch();
  assert.equal(await app.evaluate(({ app: nativeApp }) => nativeApp.getVersion()), nextVersion);
  assert.equal(await page.evaluate(() => window.kubusDesktop.stateStorage.getItem('updater-integration')), 'preserved');
  assert.equal((await page.evaluate(() => window.kubusDesktop.checkForUpdates())).status, 'up-to-date');
  assert.equal(payloadRequests, downloadsBeforeRelaunch, 'The updated app must not download its own version again');
  console.log(`PASS: installed ${currentVersion} → ${nextVersion}, reopened the new executable, and preserved desktop state`);
  await app.close();
  app = undefined;
  console.log('Updater integration passed. No release was published.');
} catch (error) {
  const log = await readFile(path.join(userData, 'logs/main.log'), 'utf8').catch(() => 'No main-process log');
  console.error(log);
  throw error;
} finally {
  // Never perform a normal quit on failure: it could install a pending update.
  const child = app?.process();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  feed.closeAllConnections();
  await new Promise((resolve) => feed.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
