import type { ResourceNamesResponse } from '@kubus/shared';
import { KUBE_LARGE_RESPONSE_DEADLINE_MS, resourcePath, type RawRequestInit } from './raw-client.js';

/**
 * Names of one kind, for pickers. A full LIST carries every object in full
 * (a CRD list carries every schema), so this asks for a server-side Table
 * without objects: one short row per object. API servers that cannot render
 * tables fall back to metadata-only objects, then to plain JSON. Pages run to
 * the end, up to a cap.
 */

/** Table first, then PartialObjectMetadataList, then whatever the server has. */
export const NAMES_ACCEPT = 'application/json;as=Table;v=v1;g=meta.k8s.io,application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io,application/json';
export const MAX_NAMES = 5000;
const PAGE_SIZE = 500;

interface NamesPage {
  kind?: string;
  metadata?: { continue?: string };
  columnDefinitions?: Array<{ name?: string; format?: string }>;
  rows?: Array<{ cells?: unknown[]; object?: { metadata?: { name?: string } } }>;
  items?: Array<{ metadata?: { name?: string } }>;
}

export function namesFromPage(page: NamesPage): string[] {
  if (page.kind === 'Table') {
    const columns = page.columnDefinitions ?? [];
    let col = columns.findIndex((c) => c.format === 'name');
    if (col < 0) col = columns.findIndex((c) => c.name?.toLowerCase() === 'name');
    return (page.rows ?? []).flatMap((row) => {
      const name = row.object?.metadata?.name ?? row.cells?.[Math.max(col, 0)];
      return typeof name === 'string' && name ? [name] : [];
    });
  }
  return (page.items ?? []).flatMap((item) => (item.metadata?.name ? [item.metadata.name] : []));
}

export async function listResourceNames(
  raw: { json<T>(path: string, init?: RawRequestInit): Promise<T> },
  gvr: { group: string; version: string; plural: string },
  namespace?: string,
): Promise<ResourceNamesResponse> {
  const names: string[] = [];
  let next: string | undefined;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), includeObject: 'None' });
    if (next) query.set('continue', next);
    const page = await raw.json<NamesPage>(resourcePath(gvr.group, gvr.version, gvr.plural, { namespace, query }), {
      headers: { accept: NAMES_ACCEPT },
      deadlineMs: KUBE_LARGE_RESPONSE_DEADLINE_MS,
    });
    names.push(...namesFromPage(page));
    next = page.metadata?.continue || undefined;
  } while (next && names.length < MAX_NAMES);
  names.sort((a, b) => a.localeCompare(b));
  const truncated = !!next || names.length > MAX_NAMES;
  return truncated ? { names: names.slice(0, MAX_NAMES), truncated } : { names };
}
