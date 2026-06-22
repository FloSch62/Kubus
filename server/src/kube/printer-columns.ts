import type { PrinterColumn } from '@kubus/shared';
import type { ClusterHandle } from './cluster-manager.js';

interface CrdVersion {
  name: string;
  additionalPrinterColumns?: Array<{ name: string; type: string; jsonPath: string; priority?: number; description?: string }>;
}

interface Crd {
  spec?: { versions?: CrdVersion[] };
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; columns: PrinterColumn[] }>();

/**
 * additionalPrinterColumns for a CRD-backed kind. Not part of API discovery —
 * they live on the CustomResourceDefinition object itself. The implicit Age
 * column is dropped (the UI always renders its own).
 */
export async function getPrinterColumns(handle: ClusterHandle, group: string, version: string, plural: string): Promise<PrinterColumn[]> {
  const key = `${handle.contextName}|${group}/${version}/${plural}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.columns;

  let columns: PrinterColumn[] = [];
  try {
    const crd = await handle.raw.json<Crd>(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${encodeURIComponent(`${plural}.${group}`)}`);
    const ver = crd.spec?.versions?.find((v) => v.name === version);
    columns = (ver?.additionalPrinterColumns ?? [])
      .filter((c) => c.jsonPath !== '.metadata.creationTimestamp')
      .map((c) => ({
        name: c.name,
        type: (['string', 'integer', 'number', 'boolean', 'date'].includes(c.type) ? c.type : 'string') as PrinterColumn['type'],
        jsonPath: c.jsonPath,
        priority: c.priority,
        description: c.description,
      }));
  } catch {
    // 404 (builtin kind / no CRD access) → no extra columns
  }
  cache.set(key, { at: Date.now(), columns });
  return columns;
}
