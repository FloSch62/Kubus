/**
 * Minimal evaluator for the Kubernetes JSONPath subset used by CRD
 * additionalPrinterColumns: leading `.`, dot segments (a `\.` inside one is
 * a literal dot, as in `.metadata.labels.app\.kubernetes\.io/name`), numeric
 * indices (`[0]`), quoted keys (`['x.y/z']`), wildcards (`[*]` / `.*`, whose
 * results are joined with `,`) and equality filters
 * (`[?(@.type=="Ready")]`, as used by cert-manager and most operators'
 * condition columns). Runs in the browser against live-watched objects;
 * returns undefined instead of throwing on any malformed path.
 */
export function evalPrinterColumnPath(obj: unknown, jsonPath: string): unknown {
  let segments = parsedPathCache.get(jsonPath);
  if (segments === undefined && !parsedPathCache.has(jsonPath)) {
    segments = parsePath(jsonPath);
    parsedPathCache.set(jsonPath, segments);
  }
  if (!segments) return undefined;
  let values: unknown[] = [obj];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const v of values) {
      if (v === null || v === undefined) continue;
      if (seg === '*') {
        if (Array.isArray(v)) next.push(...v);
        else if (typeof v === 'object') next.push(...Object.values(v as Record<string, unknown>));
      } else if (typeof seg === 'number') {
        if (Array.isArray(v)) next.push(v[seg]);
      } else if (typeof seg === 'object') {
        if (Array.isArray(v)) next.push(...v.filter((el) => filterMatches(el, seg)));
      } else if (typeof v === 'object' && !Array.isArray(v)) {
        next.push((v as Record<string, unknown>)[seg]);
      }
    }
    values = next;
  }
  const defined = values.filter((v) => v !== undefined && v !== null);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return defined
    .map((v) => {
      if (typeof v === 'object') return JSON.stringify(v);
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
      return '';
    })
    .join(',');
}

/**
 * Display text for a printer-column value: scalars as they are, a list as its
 * items joined with ", " (a Hostnames column pointing at `.spec.hostnames`),
 * any other object as JSON. Nothing to show gives undefined.
 */
export function printerColumnText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = value.map(printerColumnItem).filter((item): item is string => !!item);
    return items.length ? items.join(', ') : undefined;
  }
  return printerColumnItem(value);
}

function printerColumnItem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return undefined;
}

interface FilterSegment {
  /** Key path after `@.`, e.g. ['type'] for `@.type=="Ready"`. */
  path: string[];
  value: string;
}

type Segment = string | number | FilterSegment;

function filterMatches(el: unknown, filter: FilterSegment): boolean {
  let v: unknown = el;
  for (const key of filter.path) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    v = (v as Record<string, unknown>)[key];
  }
  if (typeof v === 'string') return v === filter.value;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v) === filter.value;
  return false;
}

const parsedPathCache = new Map<string, Segment[] | undefined>();
const INDEX_RE = /^-?\d+$/;
const FILTER_RE = /^\?\(\s*@((?:\.[A-Za-z0-9_-]+)+)\s*==\s*(['"])(.*)\2\s*\)$/;

/** One dot-segment key starting at `i`, up to the next unescaped `.` or `[`; `\x` stands for a literal `x`. */
function readKey(path: string, i: number): [string, number] {
  let key = '';
  while (i < path.length && path[i] !== '.' && path[i] !== '[') {
    if (path[i] === '\\' && i + 1 < path.length) i++;
    key += path[i++];
  }
  return [key, i];
}

function parsePath(jsonPath: string): Segment[] | undefined {
  let path = jsonPath.trim();
  if (path.startsWith('{') && path.endsWith('}')) path = path.slice(1, -1).trim();
  if (path.startsWith('$')) path = path.slice(1);
  const segments: Segment[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i++;
      if (path[i] === '*') {
        segments.push('*');
        i++;
        continue;
      }
      const [key, next] = readKey(path, i);
      i = next;
      if (key) segments.push(key);
    } else if (ch === '[') {
      const end = path.indexOf(']', i);
      if (end === -1) return undefined;
      const inner = path.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') segments.push('*');
      else if (INDEX_RE.test(inner)) segments.push(Number(inner));
      else if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) segments.push(inner.slice(1, -1));
      else {
        const filter = FILTER_RE.exec(inner);
        if (!filter) return undefined;
        segments.push({ path: filter[1]!.slice(1).split('.'), value: filter[3]! });
      }
    } else {
      // bare leading key without dot (rare but tolerated)
      const [key, next] = readKey(path, i);
      i = next;
      if (key) segments.push(key);
      else return undefined;
    }
  }
  return segments;
}
