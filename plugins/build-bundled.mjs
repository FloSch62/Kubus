import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('pnpm', ['--filter', '@kubus/plugin-clabernetes', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const destination = new URL('../client/public/plugin-bundles/clabernetes/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('./clabernetes/dist/', import.meta.url), destination, { recursive: true });
