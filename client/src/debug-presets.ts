import type { DebugImagePreset } from '@kubus/shared';

/**
 * Version-pinned so a preset never silently changes underneath a user. A
 * `profile` marks images whose tooling is useless without extra capabilities —
 * selecting one adjusts the profile dropdown in the debug dialog.
 */
export const BUILT_IN_DEBUG_IMAGES: DebugImagePreset[] = [
  { name: 'busybox', image: 'busybox:1.36', description: 'Minimal shell and coreutils (~2 MB).' },
  { name: 'DebugBox lite', image: 'ghcr.io/ibtisam-iq/debugbox:lite-1.2.0', description: 'curl, dig, jq, yq (~15 MB) — DNS and HTTP checks.' },
  { name: 'DebugBox balanced', image: 'ghcr.io/ibtisam-iq/debugbox:1.2.0', description: 'Adds bash, vim, tcpdump, strace, openssl (~47 MB).' },
  { name: 'DebugBox power', image: 'ghcr.io/ibtisam-iq/debugbox:power-1.2.0', description: 'tshark, nmap, iptables, nftables (~91 MB) — needs the network admin profile.', profile: 'netadmin' },
  { name: 'netshoot', image: 'nicolaka/netshoot:v0.16', description: 'The kitchen-sink network toolbox (~200 MB).' },
];

export function normalizeDebugImageName(name: string): string {
  return name.toLowerCase();
}

export function isBuiltInDebugImage(name: string): boolean {
  const normalizedName = normalizeDebugImageName(name);
  return BUILT_IN_DEBUG_IMAGES.some((p) => normalizeDebugImageName(p.name) === normalizedName);
}

/**
 * The effective catalog: user-defined images (Settings → Debug containers)
 * extend the built-ins; one named like a built-in replaces it in place, so
 * users can e.g. pin a different busybox tag without growing the list.
 */
export function mergeDebugPresets(custom: DebugImagePreset[] | undefined): DebugImagePreset[] {
  if (!custom?.length) return BUILT_IN_DEBUG_IMAGES;
  const byName = new Map(custom.map((c) => [normalizeDebugImageName(c.name), c]));
  const merged = BUILT_IN_DEBUG_IMAGES.map((p) => byName.get(normalizeDebugImageName(p.name)) ?? p);
  for (const c of custom) {
    if (!isBuiltInDebugImage(c.name)) merged.push(c);
  }
  return merged;
}
