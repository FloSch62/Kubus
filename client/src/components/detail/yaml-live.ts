import { useCallback, useEffect, useState } from 'react';
import type { KubeObject } from '@kubus/shared';
import type { ManifestDraft } from '../../state/detail.js';
import { dumpManifest, parseYamlMapping, rebaseEdits, sameBeyondStatus, type Change } from './manifest-tree.js';

/**
 * The YAML view edits a frozen snapshot of the live object: an editor that
 * reloads under the cursor is unusable, and an undo would bring back stale
 * text. The object itself stays live, so a change on the server raises a
 * notice instead. The snapshot is taken when the view opens and moves on
 * Reload, on Rebase, and to the first live version after an apply (the
 * apply's own response is not comparable: the server re-encodes it).
 *
 * Only drift beyond status counts, with or without edits: controllers
 * rewrite status all the time, and the write carries the latest
 * resourceVersion for such drift (yamlWithLatestVersion), so it never
 * becomes a conflict.
 */
export function useYamlSnapshot(selKey: string, active: boolean, live: KubeObject | undefined, draft: ManifestDraft | undefined) {
  const [pin, setPin] = useState<{ selKey: string; obj?: KubeObject; after?: { applied?: string; before?: string } }>();
  const own = pin?.selKey === selKey ? pin : undefined;
  useEffect(() => {
    if (!active) {
      setPin(undefined);
      return;
    }
    if (!live || own?.obj) return;
    // After an apply, wait for the applied version (or anything newer than
    // what was live when it returned) instead of pinning the old one.
    const rv = live.metadata.resourceVersion;
    if (own?.after && rv !== own.after.applied && rv === own.after.before) return;
    setPin({ selKey, obj: live });
  }, [active, live, own, selKey]);

  const reference = draft?.base ?? own?.obj;
  const moved = active && !!live && !!reference && !sameBeyondStatus(reference, live);
  const pinTo = useCallback((obj: KubeObject) => setPin({ selKey, obj }), [selKey]);
  const liveRv = live?.metadata.resourceVersion;
  const afterApply = useCallback(
    (applied: KubeObject) => setPin({ selKey, after: { applied: applied.metadata.resourceVersion, before: liveRv } }),
    [selKey, liveRv],
  );
  return { snapshot: own?.obj ?? live, moved, pinTo, afterApply };
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
