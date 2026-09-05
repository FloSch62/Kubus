import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir) throw new Error('Run this script through Electrobun build.');
const candidates = readdirSync(buildDir).map((name) => path.join(buildDir, name));
const root = candidates.find((candidate) => existsSync(path.join(candidate, 'Resources/main.js')) || existsSync(path.join(candidate, 'Contents/Resources/main.js')));
if (!root) throw new Error(`Electrobun runtime resources missing in ${buildDir}`);
const resources = path.join(root, process.platform === 'darwin' ? 'Contents/Resources' : 'Resources');
const bin = path.join(root, process.platform === 'darwin' ? 'Contents/MacOS' : 'bin');
const rendererConfig = JSON.parse(readFileSync(path.join(resources, 'build.json'), 'utf8'));
assert.equal(rendererConfig.defaultRenderer, 'native', 'Kubus must use the system webview');
assert.deepEqual(rendererConfig.availableRenderers, ['native'], 'Bundled Chromium is forbidden');
if (process.platform === 'linux') {
  // Electrobun 2.0.1 loads the native window icon relative to its bin cwd.
  // The builder's app/icon.png alone does not populate _NET_WM_ICON.
  mkdirSync(path.join(bin, 'Resources'), { recursive: true });
  // Keep the uncompressed X11 icon property small enough for GTK/X11.
  copyFileSync('assets/icon.iconset/icon_128x128.png', path.join(bin, 'Resources/appIcon.png'));
}

await build({ entryPoints: ['src/instance-worker.ts'], outfile: path.join(resources, 'kubus-instance.js'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
const boot = path.join(resources, 'main.js');
const runtime = readFileSync(boot, 'utf8');
const marker = '// Kubus single-instance bootstrap';
if (!runtime.includes(marker)) writeFileSync(boot, `${marker}
const kubusInstanceWorker = new Worker(new URL('./kubus-instance.js', import.meta.url).href);
await new Promise((resolve, reject) => {
  kubusInstanceWorker.onmessage = (event) => { if (!event.data.claimed) process.exit(0); resolve(); };
  kubusInstanceWorker.onerror = reject;
});
${runtime}`);
const windows = process.platform === 'win32';
execFileSync('go', ['build', '-trimpath', `-ldflags=-s -w${windows ? ' -H=windowsgui' : ''}`, '-o', path.join(bin, windows ? 'kubus-link.exe' : 'kubus-link'), 'launcher/main.go'], { stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } });
