export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Minimal Prometheus text-exposition parser for scraping agent endpoints.
 * Only samples whose family is in `families` are returned — callers pass the
 * handful of metric names they consume so multi-megabyte exposition bodies
 * don't allocate label maps for series nobody reads.
 */
export function parsePrometheusText(text: string, families: ReadonlySet<string>): PromSample[] {
  const samples: PromSample[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const space = line.indexOf(' ');
    const nameEnd = brace >= 0 && (space < 0 || brace < space) ? brace : space;
    if (nameEnd <= 0) continue;
    const name = line.slice(0, nameEnd);
    if (!families.has(name)) continue;

    let labels: Record<string, string> = {};
    let rest: string;
    if (nameEnd === brace) {
      const parsed = parseLabels(line, brace + 1);
      if (!parsed) continue;
      labels = parsed.labels;
      rest = line.slice(parsed.end);
    } else {
      rest = line.slice(nameEnd);
    }
    // Value is the first whitespace-separated token; an optional timestamp follows.
    const value = Number.parseFloat(rest.trim().split(/\s+/, 1)[0] ?? '');
    if (Number.isNaN(value)) continue;
    samples.push({ name, labels, value });
  }
  return samples;
}

/** Parse `key="value",…}` starting after the opening brace; returns the index after `}`. */
function parseLabels(line: string, start: number): { labels: Record<string, string>; end: number } | undefined {
  const labels: Record<string, string> = {};
  let i = start;
  for (;;) {
    while (line[i] === ',' || line[i] === ' ') i++;
    if (line[i] === '}') return { labels, end: i + 1 };
    const eq = line.indexOf('=', i);
    if (eq < 0 || line[eq + 1] !== '"') return undefined;
    const key = line.slice(i, eq).trim();
    let value = '';
    let j = eq + 2;
    for (; j < line.length; j++) {
      const ch = line[j];
      if (ch === '\\') {
        const next = line[j + 1];
        value += next === 'n' ? '\n' : (next ?? '');
        j++;
      } else if (ch === '"') {
        break;
      } else {
        value += ch;
      }
    }
    if (j >= line.length) return undefined;
    labels[key] = value;
    i = j + 1;
  }
}
