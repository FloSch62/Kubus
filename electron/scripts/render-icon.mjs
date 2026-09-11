import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Render the app icons from the Kubus SVG: icon.png (1024px) feeds the
// mac .icns / win .ico generation, icons/<size> the Linux hicolor set,
// and appx/<name> the Microsoft Store package tiles.
const root = path.dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(import.meta.url);
const svg = path.resolve(root, '../../client/public/kubus.svg');
const main = path.resolve(root, '../build/icon.png');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
// Keep the transparent glyph inside a macOS-friendly safe area instead of
// letting the non-square SVG fill and crop the generated square icon.
const contentScale = 0.82;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const mtime = async (p) => (await stat(p).catch(() => undefined))?.mtimeMs ?? 0;

const sourceMtime = async () => Math.max(await mtime(svg), await mtime(script));

const outdated = async (p) => (await mtime(p)) <= (await sourceMtime());

const render = async (width, file, height = width) => {
  const contentSize = Math.max(1, Math.round(Math.min(width, height) * contentScale));
  const left = Math.floor((width - contentSize) / 2);
  const top = Math.floor((height - contentSize) / 2);
  return sharp(svg, { density: 300 })
    .resize({
      width: contentSize,
      height: contentSize,
      fit: 'contain',
      background: transparent,
    })
    .extend({
      left,
      top,
      right: width - contentSize - left,
      bottom: height - contentSize - top,
      background: transparent,
    })
    .png()
    .toFile(file);
};

await mkdir(path.resolve(root, '../build/icons'), { recursive: true });
if (await outdated(main)) {
  await render(1024, main);
  console.log(`rendered ${main}`);
}
for (const size of sizes) {
  const file = path.resolve(root, `../build/icons/${size}x${size}.png`);
  if (await outdated(file)) await render(size, file);
}

// Supply every default AppX asset so electron-builder never uses sample tiles.
await mkdir(path.resolve(root, '../build/appx'), { recursive: true });
for (const [name, width, height] of [
  ['StoreLogo.png', 50, 50],
  ['Square44x44Logo.png', 44, 44],
  ['Square150x150Logo.png', 150, 150],
  ['Wide310x150Logo.png', 310, 150],
]) {
  const file = path.resolve(root, '../build/appx', name);
  if (await outdated(file)) await render(width, file, height);
}
