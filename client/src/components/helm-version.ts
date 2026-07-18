interface Semver {
  numbers: [number, number, number];
  prerelease?: string;
}

function parseSemver(value: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

/** Positive when left is newer, negative when it is older. */
export function compareHelmVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a && b) {
    for (let index = 0; index < a.numbers.length; index++) {
      const delta = a.numbers[index]! - b.numbers[index]!;
      if (delta) return delta;
    }
    if (!a.prerelease && b.prerelease) return 1;
    if (a.prerelease && !b.prerelease) return -1;
    return (a.prerelease ?? '').localeCompare(b.prerelease ?? '', undefined, { numeric: true });
  }
  return left.localeCompare(right, undefined, { numeric: true });
}
