// Download the optional browser trial without requiring Python or a native engine.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const revision = 'b274efcb211a9eef48c9a88da4b43bd569696a39';
const base = `https://huggingface.co/Cactus-Compute/needle3/resolve/${revision}/`;
const destination = new URL('../client/public/needle/', import.meta.url);
const moduleExport = '\nexport default createNeedle;\n';
const assets = [
  ['wasm/needle.js', 'needle.mjs', 'd00ec67ec7e03e4720dfc6c3dad95a0540afd00169a983ce3fabcd7aeaa0fa93'],
  ['wasm/needle.wasm', 'needle.wasm', '77c6a38cacb8efbeebfd5202082ba9a0850a7c3066db40d4d0e80509cd137d9b'],
  ['needle3.cact', 'needle3.cact', 'c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38'],
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

await mkdir(destination, { recursive: true });
for (const [source, name, expected] of assets) {
  const target = new URL(name, destination);
  const suffix = name.endsWith('.mjs') ? Buffer.from(moduleExport) : Buffer.alloc(0);
  const existing = await readFile(target).catch(() => null);
  if (existing && sha256(existing.subarray(0, existing.length - suffix.length)) === expected &&
      existing.subarray(existing.length - suffix.length).equals(suffix)) {
    console.log(`${name}: verified`);
    continue;
  }
  console.log(`Downloading ${source}…`);
  const response = await fetch(`${base}${source}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${source}: SHA-256 mismatch`);
  const temporary = new URL(`${name}.tmp`, destination);
  try {
    await writeFile(temporary, Buffer.concat([bytes, suffix]));
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log(`Needle trial ready in ${fileURLToPath(destination)}. Run pnpm dev, or rebuild to include it in the desktop app.`);
