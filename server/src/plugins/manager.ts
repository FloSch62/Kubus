import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginInfo, PluginManifest } from '@kubus/shared';
import type { SettingsStore } from '../settings-store.js';
import { HttpProblem } from '../util/errors.js';
import { pluginManifestSchema } from './manifest.js';

interface Bundle {
  root: string;
  manifest: PluginManifest;
  bundled: boolean;
  error?: string;
}
const allowedExtensions = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.woff',
  '.woff2',
  '.txt',
]);

/** Static bundles only: never evaluates plugin code in Node or loads server extensions. */
export class PluginManager {
  private bundles = new Map<string, Bundle>();
  readonly installRoot: string;

  constructor(
    private settings: SettingsStore,
    bundledRoot: string,
  ) {
    this.installRoot = path.join(path.dirname(settings.filePath), 'plugins');
    for (const [root, bundled] of [
      [bundledRoot, true],
      [this.installRoot, false],
    ] as const) {
      if (!fs.existsSync(root)) continue;
      for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
        const bundleRoot = path.join(root, dir.name);
        try {
          const manifest = this.readManifest(bundleRoot);
          if (!this.bundles.has(manifest.id)) this.bundles.set(manifest.id, { root: bundleRoot, manifest, bundled });
        } catch (error) {
          // One broken extension must never prevent Kubus from starting.
          console.warn(`Ignoring invalid plugin ${dir.name}: ${String(error)}`);
        }
      }
    }
  }

  private readManifest(root: string): PluginManifest {
    try {
      const file = path.join(root, 'kubus-plugin.json');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 32_768) throw new HttpProblem(400, 'Invalid plugin manifest');
      const parsed = pluginManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) throw new HttpProblem(400, `Invalid plugin manifest: ${parsed.error.issues[0]?.message}`);
      if (!fs.lstatSync(path.join(root, parsed.data.entry)).isFile()) throw new HttpProblem(400, 'Missing plugin entry');
      return parsed.data;
    } catch (error) {
      if (error instanceof HttpProblem) throw error;
      throw new HttpProblem(400, 'The directory must contain valid kubus-plugin.json and index.html files');
    }
  }

  list(): PluginInfo[] {
    const states = this.settings.load().plugins;
    return [...this.bundles.values()]
      .map((b) => ({ manifest: b.manifest, bundled: b.bundled, enabled: states?.[b.manifest.id]?.enabled === true, error: b.error }))
      .sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.manifest.name.localeCompare(b.manifest.name));
  }

  get(id: string, requireEnabled = true): Bundle {
    const bundle = this.bundles.get(id);
    if (!bundle) throw new HttpProblem(404, 'Plugin not found');
    if (requireEnabled && this.settings.load().plugins?.[id]?.enabled !== true) throw new HttpProblem(403, 'Plugin is disabled');
    return bundle;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.get(id, false);
    this.settings.save({ plugins: { ...this.settings.load().plugins, [id]: { enabled } } });
  }

  install(source: string): PluginInfo[] {
    if (!path.isAbsolute(source)) throw new HttpProblem(400, 'Choose an absolute plugin directory path on the Kubus server');
    let root: string;
    try {
      root = fs.realpathSync(source);
    } catch {
      throw new HttpProblem(400, 'Plugin directory could not be found or read');
    }
    const manifest = this.readManifest(root);
    if (this.bundles.has(manifest.id))
      throw new HttpProblem(409, 'A plugin with this ID is already installed. Remove it before installing a replacement.');
    // Collect bytes before writing. Reject symlinks, hidden files, special files,
    // oversized bundles and unexpected extensions; installed code is a snapshot.
    const files: Array<{ name: string; bytes: Buffer }> = [];
    let total = 0;
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) throw new HttpProblem(400, 'Plugin bundles must not contain hidden files');
        const name = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (name.split(path.sep).length > 8) throw new HttpProblem(400, 'Plugin directories are nested too deeply');
          visit(name);
          continue;
        }
        if (!entry.isFile() || !allowedExtensions.has(path.extname(name))) throw new HttpProblem(400, `Unsupported plugin file: ${name}`);
        const stat = fs.lstatSync(path.join(root, name));
        total += stat.size;
        if (total > 64 * 1024 * 1024 || files.length >= 2000) throw new HttpProblem(400, 'Plugin bundle exceeds 64 MiB or 2000 files');
        // O_NOFOLLOW also rejects a symlink substituted after directory traversal.
        const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          files.push({ name, bytes: fs.readFileSync(fd) });
        } finally {
          fs.closeSync(fd);
        }
      }
    };
    visit('');
    const staged = path.join(this.installRoot, `.install-${randomUUID()}`);
    try {
      fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const dest = path.join(staged, file.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.bytes);
      }
      // Parse the exact copied manifest, never trust the earlier source read.
      const copied = this.readManifest(staged);
      if (copied.id !== manifest.id) throw new HttpProblem(400, 'Plugin changed during installation');
      const destination = path.join(this.installRoot, copied.id);
      fs.renameSync(staged, destination);
      this.bundles.set(copied.id, { root: destination, manifest: copied, bundled: false });
      this.setEnabled(copied.id, false);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
    return this.list();
  }

  remove(id: string): void {
    const bundle = this.get(id, false);
    if (bundle.bundled) throw new HttpProblem(400, 'Bundled plugins can be disabled, but cannot be removed');
    this.setEnabled(id, false);
    fs.rmSync(bundle.root, { recursive: true });
    this.bundles.delete(id);
  }

  asset(id: string, relative: string): Buffer {
    const bundle = this.get(id);
    if (relative.split(/[\\/]/).some((s) => !s || s.startsWith('.')) || !allowedExtensions.has(path.extname(relative)))
      throw new HttpProblem(404, 'Plugin asset not found');
    const real = fs.realpathSync(path.join(bundle.root, relative));
    if (!real.startsWith(fs.realpathSync(bundle.root) + path.sep)) throw new HttpProblem(404, 'Plugin asset not found');
    return fs.readFileSync(real);
  }
}
