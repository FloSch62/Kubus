import type { KubeObject } from '@kubus/shared';

/** Mirrors the server's Secret redaction placeholder (server/src/kube/redact.ts). */
export const REDACTED = '••••••••';

/** Manifest field a key is stored in. ConfigMaps split text/binary; Secrets only use `data`. */
export type DataField = 'data' | 'binaryData';

export type ValueMode = 'text' | 'binary';

export interface DataEntry {
  /** Stable identity for React keys across renames. */
  id: number;
  /** Current key name (editable). */
  name: string;
  /** Key name on the server; undefined for newly added keys. */
  originalName?: string;
  /** Server-side value in manifest encoding (base64 for Secret data / binaryData, plain for ConfigMap data). */
  storedRaw?: string;
  /** Field the key currently lives in on the server. */
  storedField?: DataField;
  /** Editing mode: `text` edits the decoded UTF-8 string, `binary` edits base64. */
  mode: ValueMode;
  /** Current value in the mode's encoding. */
  value: string;
  deleted: boolean;
}

export interface EntryProblem {
  id: number;
  target: 'name' | 'value';
  message: string;
}

// ---- Encoding ----

export function textToB64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function isValidB64(s: string): boolean {
  try {
    atob(s);
    return true;
  } catch {
    return false;
  }
}

/** Byte size of a base64 payload without decoding it. */
export function b64ByteLength(b64: string): number {
  const clean = b64.replace(WHITESPACE_RE, '');
  if (!clean.length) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return (clean.length / 4) * 3 - padding;
}

const WHITESPACE_RE = /\s/g;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Control characters other than \t \n \r mean "not editable as text". */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}

/** Decode base64 to a UTF-8 string, or undefined when the payload isn't editable text. */
export function b64ToText(b64: string): string | undefined {
  let text: string;
  try {
    text = UTF8_DECODER.decode(b64ToBytes(b64));
  } catch {
    return undefined;
  }
  return hasControlChars(text) ? undefined : text;
}

// ---- Draft model ----

function dataMap(obj: KubeObject, field: DataField): Array<[string, string]> {
  const map = obj[field] as Record<string, unknown> | undefined;
  return Object.entries(map ?? {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string');
}

/** Build the initial draft from a (revealed, for Secrets) server object. */
export function entriesFromObject(obj: KubeObject, isSecret: boolean, startId: number): DataEntry[] {
  const entries: DataEntry[] = [];
  let id = startId;
  for (const [name, raw] of dataMap(obj, 'data')) {
    if (isSecret) {
      const text = b64ToText(raw);
      entries.push({ id: id++, name, originalName: name, storedRaw: raw, storedField: 'data', mode: text === undefined ? 'binary' : 'text', value: text ?? raw, deleted: false });
    } else {
      entries.push({ id: id++, name, originalName: name, storedRaw: raw, storedField: 'data', mode: 'text', value: raw, deleted: false });
    }
  }
  for (const [name, raw] of dataMap(obj, 'binaryData')) {
    entries.push({ id: id++, name, originalName: name, storedRaw: raw, storedField: 'binaryData', mode: 'binary', value: raw, deleted: false });
  }
  return entries;
}

/** Current value of an entry in manifest encoding. */
export function entryRaw(entry: DataEntry, isSecret: boolean): string {
  if (entry.mode === 'binary') return entry.value.replace(WHITESPACE_RE, '');
  return isSecret ? textToB64(entry.value) : entry.value;
}

/** Field the entry will be written to on apply. */
export function entryField(entry: DataEntry, isSecret: boolean): DataField {
  if (isSecret) return 'data';
  return entry.mode === 'binary' ? 'binaryData' : 'data';
}

export function entryDirty(entry: DataEntry, isSecret: boolean): boolean {
  if (!entry.originalName) return true;
  if (entry.deleted) return true;
  if (entry.name !== entry.originalName) return true;
  if (entryField(entry, isSecret) !== entry.storedField) return true;
  return entryRaw(entry, isSecret) !== entry.storedRaw;
}

export function anyDirty(entries: DataEntry[], isSecret: boolean): boolean {
  return entries.some((e) => entryDirty(e, isSecret));
}

const KEY_NAME_RE = /^[-._a-zA-Z0-9]+$/;

export function validateEntries(entries: DataEntry[]): EntryProblem[] {
  const problems: EntryProblem[] = [];
  const live = entries.filter((e) => !e.deleted);
  const nameCounts = new Map<string, number>();
  for (const e of live) nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1);
  for (const e of live) {
    if (!e.name) {
      problems.push({ id: e.id, target: 'name', message: 'Key name is required' });
    } else if (e.name.length > 253) {
      problems.push({ id: e.id, target: 'name', message: 'Key name must be at most 253 characters' });
    } else if (!KEY_NAME_RE.test(e.name)) {
      problems.push({ id: e.id, target: 'name', message: "Key may contain only letters, digits, '-', '_' and '.'" });
    } else if ((nameCounts.get(e.name) ?? 0) > 1) {
      problems.push({ id: e.id, target: 'name', message: 'Duplicate key name' });
    }
    if (e.mode === 'binary' && !isValidB64(e.value.replace(WHITESPACE_RE, ''))) {
      problems.push({ id: e.id, target: 'value', message: 'Not valid base64' });
    }
  }
  return problems;
}

/**
 * Build the manifest to apply: the latest server object with the draft's
 * per-key operations replayed onto it. Keys the draft never touched mirror
 * the server's current state — they keep a concurrently edited value and
 * stay absent when another client deleted them — so the PUT replace only
 * asserts the keys this draft actually changed.
 */
export function buildManifest(latest: KubeObject, entries: DataEntry[], isSecret: boolean): KubeObject {
  const clone = JSON.parse(JSON.stringify(latest)) as KubeObject;
  const meta = clone.metadata as unknown as Record<string, unknown>;
  delete meta.managedFields;
  // stringData is write-only; a read object should never carry it into a PUT.
  delete clone.stringData;

  const latestValues = { data: new Map(dataMap(latest, 'data')), binaryData: new Map(dataMap(latest, 'binaryData')) };
  const result = { data: new Map(latestValues.data), binaryData: new Map(latestValues.binaryData) };
  for (const e of entries) {
    if (e.originalName && e.storedField) result[e.storedField].delete(e.originalName);
  }
  for (const e of entries) {
    if (e.deleted) continue;
    const field = entryField(e, isSecret);
    if (!entryDirty(e, isSecret)) {
      const raw = latestValues[field].get(e.name);
      if (raw !== undefined) result[field].set(e.name, raw);
      continue;
    }
    result[field].set(e.name, entryRaw(e, isSecret));
  }
  for (const field of ['data', 'binaryData'] as const) {
    if (result[field].size) clone[field] = Object.fromEntries(result[field]);
    else delete clone[field];
  }
  return clone;
}

/**
 * Redact Secret values for the diff view. `shown` decides per key; values the
 * user typed or explicitly revealed stay visible, everything else is masked on
 * both sides so unchanged keys don't leak and produce no diff noise.
 */
export function maskSecretValues(obj: KubeObject, shown: (name: string) => boolean): KubeObject {
  const clone = JSON.parse(JSON.stringify(obj)) as KubeObject;
  for (const field of ['data', 'binaryData'] as const) {
    const map = clone[field] as Record<string, unknown> | undefined;
    if (!map) continue;
    for (const key of Object.keys(map)) {
      if (!shown(key)) map[key] = REDACTED;
    }
  }
  return clone;
}
