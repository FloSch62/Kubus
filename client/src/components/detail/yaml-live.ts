import { useCallback, useEffect, useState } from 'react';
import type { KubeObject } from '@kubus/shared';
import type { ManifestDraft } from '../../state/detail.js';
import { deepEqual, dumpManifest, parseYamlMapping, rebaseEdits, type Change } from './manifest-tree.js';

interface Pin {
  selKey: string;
  obj?: KubeObject;
  /** After an apply: follow the live object until it moves past this version, then pin that. */
  afterRv?: string;
}

/**
 * The YAML view edits a frozen snapshot of the live object: an editor that
 * reloads under the cursor is unusable, and an undo would bring back stale
 * text. The object itself stays live, so a change on the server raises a
 * notice instead. The snapshot is taken when the view opens and moves on
 * Reload, on Rebase, and once an apply comes back from the server.
 *
 * With edits staged any new version counts (the apply would hit a 409); a
 * clean editor only flags changes beyond status, which controllers rewrite
 * all the time.
 */
export function useYamlSnapshot(selKey: string, active: boolean, live: KubeObject | undefined, draft: ManifestDraft | undefined) {
  const [pin, setPin] = useState<Pin>();
  const own = pin?.selKey === selKey ? pin : undefined;
  useEffect(() => {
    if (!active) {
      setPin(undefined);
      return;
    }
    if (!live || own?.obj) return;
    if (own?.afterRv !== undefined && live.metadata.resourceVersion === own.afterRv) return;
    setPin({ selKey, obj: live });
  }, [active, live, own, selKey]);

  const moved =
    active && !!live && (draft ? live.metadata.resourceVersion !== draft.base.metadata.resourceVersion : !!own?.obj && !sameBeyondStatus(own.obj, live));
  const pinTo = useCallback((obj: KubeObject) => setPin({ selKey, obj }), [selKey]);
  const afterApply = useCallback((appliedFrom: string | undefined) => setPin({ selKey, afterRv: appliedFrom }), [selKey]);
  return { snapshot: own?.obj ?? live, moved, pinTo, afterApply };
}

/** Equal apart from status and the bookkeeping that changes with every write. */
function sameBeyondStatus(a: KubeObject, b: KubeObject): boolean {
  if (a.metadata.resourceVersion === b.metadata.resourceVersion) return true;
  const strip = ({ status: _status, metadata, ...rest }: KubeObject) => {
    const { resourceVersion: _rv, generation: _generation, managedFields: _managed, ...meta } = metadata as KubeObject['metadata'] & { generation?: number; managedFields?: unknown };
    return { ...rest, metadata: meta };
  };
  return deepEqual(strip(a), strip(b));
}

export type YamlRebase = { ok: true; draft: ManifestDraft; skipped: Change[] } | { ok: false; error: string };

/**
 * Replay a YAML draft's edits onto the latest object. The text is
 * re-serialized from the result, so it keeps every edit but not the
 * original formatting or comments.
 */
export function rebaseYamlDraft(draft: ManifestDraft, latest: KubeObject): YamlRebase {
  const parsed = parseYamlMapping(draft.text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { value, skipped } = rebaseEdits(draft.base, parsed.value, latest);
  return {
    ok: true,
    skipped,
    draft: { ...draft, base: latest, baseText: dumpManifest(latest), obj: value as KubeObject, text: dumpManifest(value), mode: 'yaml' },
  };
}
