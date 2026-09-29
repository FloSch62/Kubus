import { dump as dumpYaml } from 'js-yaml';
import type { DataEntry } from './data-editor.js';

/** `env`: one `KEY=value` line per key. `yaml`: a manifest fragment ready to paste. */
export type DataCopyFormat = 'env' | 'yaml';

export interface DataCopyResult {
  text: string;
  /** Keys included in `text`. */
  count: number;
  /** Binary keys left out because the format has no way to carry bytes. */
  skipped: string[];
}

// Values made only of these characters survive every .env reader unquoted.
const PLAIN_ENV_VALUE_RE = /^[^\s"'`#$\\]*$/;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', $: '\\$' };

/**
 * Quote a value for a .env file. Single quotes keep it literal everywhere
 * (docker compose, dotenv-expand and shells interpolate `$` inside double
 * quotes, so `pa$word` would lose `$word`). Values holding a single quote or
 * a line break need double quotes; there `$`, quotes, backslashes and line
 * breaks are escaped.
 */
export function envValue(value: string): string {
  if (PLAIN_ENV_VALUE_RE.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  return `"${value.replace(/[\\"\n\r$]/g, (ch) => DOUBLE_QUOTE_ESCAPES[ch] ?? ch)}"`;
}

/**
 * Serialize the editor's keys as they stand (staged edits included, removed
 * and unnamed keys left out). Text values are the decoded strings; binary
 * values stay base64. YAML follows the manifest fields: a ConfigMap's text
 * keys under `data` and binary keys under `binaryData`, a Secret's text keys
 * under `stringData` and binary keys under `data`.
 */
export function serializeDataEntries(entries: DataEntry[], format: DataCopyFormat, isSecret: boolean): DataCopyResult {
  const live = entries.filter((e) => !e.deleted && e.name.trim());
  if (format === 'env') {
    const skipped = live.filter((e) => e.mode === 'binary').map((e) => e.name);
    const lines = live.filter((e) => e.mode === 'text').map((e) => `${e.name}=${envValue(e.value)}`);
    return { text: lines.length ? `${lines.join('\n')}\n` : '', count: lines.length, skipped };
  }
  const text: Record<string, string> = {};
  const binary: Record<string, string> = {};
  for (const e of live) {
    if (e.mode === 'binary') binary[e.name] = e.value.replace(/\s/g, '');
    else text[e.name] = e.value;
  }
  const doc: Record<string, Record<string, string>> = {};
  if (Object.keys(text).length) doc[isSecret ? 'stringData' : 'data'] = text;
  if (Object.keys(binary).length) doc[isSecret ? 'data' : 'binaryData'] = binary;
  return { text: live.length ? dumpYaml(doc, { noRefs: true, lineWidth: -1 }) : '', count: live.length, skipped: [] };
}
