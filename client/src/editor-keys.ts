interface ChordLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const isMod = (e: ChordLike) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

/** Mod+S: review and apply the staged manifest edits (tree and YAML view). */
export function isSaveChord(e: ChordLike): boolean {
  return isMod(e) && e.key.toLowerCase() === 's';
}

/** Mod+Enter: run a create dialog's primary action. */
export function isSubmitChord(e: ChordLike): boolean {
  return isMod(e) && e.key === 'Enter';
}
