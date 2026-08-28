import type { DebugImagePreset, DebugProfile } from '@kubus/shared';
import type { SettingsStore } from './settings-store.js';
import { HttpProblem } from './util/errors.js';

/**
 * User-defined debug container images (settings.json `debugImages`). The
 * client offers them as preset chips next to the built-in catalog; an entry
 * with the same name as a built-in preset replaces it, so users can e.g. pin
 * a different busybox tag.
 */

const PROFILES = new Set<string>(['general', 'restricted', 'netadmin', 'sysadmin']);

export function listDebugImages(settings: SettingsStore): DebugImagePreset[] {
  const entries = settings.load().debugImages;
  // settings.json is hand-editable; malformed entries must not break the debug dialog.
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => !!e && typeof e === 'object' && typeof e.name === 'string' && e.name.trim() !== '' && typeof e.image === 'string' && e.image.trim() !== '')
    .map((e) => ({
      name: e.name,
      image: e.image,
      description: typeof e.description === 'string' && e.description ? e.description : undefined,
      profile: typeof e.profile === 'string' && PROFILES.has(e.profile) ? (e.profile as DebugProfile) : undefined,
    }));
}

export function addDebugImage(settings: SettingsStore, preset: { name: string; image: string; description?: string; profile?: string }): DebugImagePreset {
  const name = preset.name.trim();
  const image = preset.image.trim();
  if (!name || name.length > 40) throw new HttpProblem(422, 'name is required and may be at most 40 characters');
  if (!image || image.length > 300) throw new HttpProblem(422, 'image is required and may be at most 300 characters');
  if (/\s/.test(image)) throw new HttpProblem(422, 'image must be a reference without whitespace');
  const description = preset.description?.trim() || undefined;
  if (description && description.length > 200) throw new HttpProblem(422, 'description may be at most 200 characters');
  const profile = preset.profile || undefined;
  if (profile !== undefined && !PROFILES.has(profile)) throw new HttpProblem(422, `unknown debug profile ${profile}`);
  const existing = listDebugImages(settings);
  if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new HttpProblem(409, `debug image "${name}" already exists`);
  const entry: DebugImagePreset = { name, image, description, profile: profile as DebugProfile | undefined };
  settings.save({ debugImages: [...existing, entry] });
  return entry;
}

export function removeDebugImage(settings: SettingsStore, name: string): void {
  const entries = listDebugImages(settings);
  const next = entries.filter((e) => e.name !== name);
  if (next.length === entries.length) throw new HttpProblem(404, `debug image "${name}" not found`);
  settings.save({ debugImages: next });
}
