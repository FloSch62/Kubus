/**
 * Parse Kubernetes resource quantities.
 * CPU: "100m" (millicores), "250000000n" (nanocores), "2" (cores), "1500u".
 * Memory: "128974848", "129Mi", "1Gi", "123M", "1e3Ki".
 */

const BINARY_SUFFIX: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

const DECIMAL_SUFFIX: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const QUANTITY_RE = /^([+-]?[0-9.eE+-]+?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/;

/** Parse a quantity string to a plain number (base units). */
export function parseQuantity(q: string | undefined): number {
  if (!q) return 0;
  const m = QUANTITY_RE.exec(q.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  if (Number.isNaN(value)) return 0;
  const suffix = m[2] ?? '';
  const factor = BINARY_SUFFIX[suffix] ?? DECIMAL_SUFFIX[suffix] ?? 1;
  return value * factor;
}

/** CPU quantity -> millicores. */
export function cpuToMilli(q: string | undefined): number {
  return Math.round(parseQuantity(q) * 1000);
}

/** Memory quantity -> bytes. */
export function memToBytes(q: string | undefined): number {
  return Math.round(parseQuantity(q));
}
