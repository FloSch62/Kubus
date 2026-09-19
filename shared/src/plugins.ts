import type { PluginManifest } from '@kubus/plugin-sdk/protocol';
export type * from '@kubus/plugin-sdk/protocol';
export const PLUGIN_API_VERSION = 1 as const;

export function pluginCanRead(manifest: PluginManifest, group: string, plural: string): boolean {
  return manifest.permissions.resources.some((rule) => rule.group === group && rule.resources.includes(plural));
}
