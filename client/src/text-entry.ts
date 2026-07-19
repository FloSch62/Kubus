/** Input types that don't consume typing — a focused checkbox must not block shortcuts. */
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color']);

/** True when a key event targets a surface that consumes typing (inputs, editors, menus, dialogs). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)) return true;
  return (
    target.isContentEditable ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    // Non-text inputs (grid checkboxes) don't consume typing themselves, but
    // anything inside a dialog/menu/editor still blocks global shortcuts.
    !!target.closest('[contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], .monaco-editor')
  );
}

/**
 * True when the target sits inside a surface that owns the whole keyboard
 * (terminals, code editors). Stricter than isTextEntryTarget: plain filter
 * inputs still allow e.g. Alt tab-switching chords, but a shell or editor
 * must receive every Alt sequence unmodified.
 */
export function isEditorOrTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('.xterm, .monaco-editor');
}
