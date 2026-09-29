/**
 * Stable per-context colors for cluster tags. The hues avoid the status
 * palette (green, amber, red) so a cluster tag never reads as health.
 * Each entry has a light- and a dark-mode shade; tags draw the shade as text
 * on a faint wash of the same hue.
 */
export const CLUSTER_TAG_PALETTE: ReadonlyArray<{ light: string; dark: string }> = [
  { light: '#2f5bea', dark: '#86a0fc' }, // blue
  { light: '#0f766e', dark: '#2dd4bf' }, // teal
  { light: '#7c3aed', dark: '#b69cfb' }, // violet
  { light: '#be185d', dark: '#f9a8d4' }, // magenta
  { light: '#52525b', dark: '#c4c4cc' }, // slate
  { light: '#0369a1', dark: '#7dd3fc' }, // sky
];

function hash(text: string): number {
  // FNV-1a: cheap, and spreads similar names (kind-a, kind-b) apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Palette slot per context. Each context prefers the slot its name hashes to;
 * when two of the given contexts collide, the later one (by name) takes the
 * next free slot, so the clusters shown side by side never share a color.
 */
export function clusterColorIndexes(contexts: readonly string[]): Map<string, number> {
  const size = CLUSTER_TAG_PALETTE.length;
  const taken = new Set<number>();
  const result = new Map<string, number>();
  for (const ctx of [...new Set(contexts)].sort()) {
    const preferred = hash(ctx) % size;
    let slot = preferred;
    for (let step = 0; step < size && taken.has(slot); step++) slot = (preferred + step + 1) % size;
    if (taken.has(slot)) slot = preferred;
    taken.add(slot);
    result.set(ctx, slot);
  }
  return result;
}

export function clusterTagColors(index: number, mode: 'light' | 'dark'): { fg: string; bg: string } {
  const entry = CLUSTER_TAG_PALETTE[((index % CLUSTER_TAG_PALETTE.length) + CLUSTER_TAG_PALETTE.length) % CLUSTER_TAG_PALETTE.length]!;
  const fg = mode === 'dark' ? entry.dark : entry.light;
  return { fg, bg: `${fg}${mode === 'dark' ? '26' : '14'}` };
}

/**
 * The part of a kubeconfig context name that tells clusters apart: `kind-dev`
 * → `dev`, an EKS ARN → the cluster name, `gke_project_zone_name` → `name`.
 * Other names are returned unchanged.
 */
export function shortContextName(ctx: string): string {
  const eks = /^arn:aws[\w-]*:eks:[^:]*:\d*:cluster\/(.+)$/.exec(ctx);
  if (eks?.[1]) return eks[1];
  const gke = /^gke_[^_]+_[^_]+_(.+)$/.exec(ctx);
  if (gke?.[1]) return gke[1];
  if (ctx.startsWith('kind-') && ctx.length > 5) return ctx.slice(5);
  return ctx;
}
