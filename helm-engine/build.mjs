#!/usr/bin/env node
// Builds the Helm rendering engine (Go, helm.sh/helm/v3) to a WASI module and
// stores it gzipped where the server expects it: server/assets/helm-engine.wasm.gz
// Requires a Go toolchain; the artifact itself is platform-independent.
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpOut = path.join(here, 'helm-engine.wasm');
const assetDir = path.join(here, '..', 'server', 'assets');
const asset = path.join(assetDir, 'helm-engine.wasm.gz');

try {
  execFileSync('go', ['version'], { stdio: 'ignore' });
} catch {
  console.error('helm-engine: Go toolchain not found; skipping build.');
  console.error('Install/upgrade of Helm releases will be unavailable until server/assets/helm-engine.wasm.gz is built.');
  process.exit(1);
}

console.log('helm-engine: compiling (GOOS=wasip1 GOARCH=wasm)...');
execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', tmpOut, '.'], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, GOOS: 'wasip1', GOARCH: 'wasm' },
});

mkdirSync(assetDir, { recursive: true });
const wasm = readFileSync(tmpOut);
writeFileSync(asset, gzipSync(wasm, { level: 9 }));
rmSync(tmpOut);
console.log(`helm-engine: wrote ${asset} (${(wasm.length / 1e6).toFixed(1)}MB wasm, gzipped)`);
