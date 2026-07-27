import type { ResourceKindInfo } from '@kubus/shared';

const VERSION_RE = /^v(\d+)(?:(alpha|beta)(\d+))?$/;

function versionScore(version: string): [number, number, number] {
  const match = VERSION_RE.exec(version);
  if (!match) return [0, 0, 0];
  const stability = match[2] === 'alpha' ? 1 : match[2] === 'beta' ? 2 : 3;
  return [stability, Number(match[1]), Number(match[3] ?? 0)];
}

/** The more current of two versions of one kind: stable over beta over alpha, then newest. */
export function preferVersion(candidate: ResourceKindInfo, current: ResourceKindInfo): ResourceKindInfo {
  const a = versionScore(candidate.version);
  const b = versionScore(current.version);
  if (a[0] !== b[0]) return a[0] > b[0] ? candidate : current;
  if (a[1] !== b[1]) return a[1] > b[1] ? candidate : current;
  if (a[2] !== b[2]) return a[2] > b[2] ? candidate : current;
  return candidate.version.localeCompare(current.version) > 0 ? candidate : current;
}

/** The version of `group/plural` worth linking to among the discovered kinds. */
export function preferredKind(group: string, plural: string, kinds: ResourceKindInfo[]): ResourceKindInfo | undefined {
  let best: ResourceKindInfo | undefined;
  for (const kind of kinds) {
    if (kind.group !== group || kind.plural !== plural) continue;
    best = best ? preferVersion(kind, best) : kind;
  }
  return best;
}
