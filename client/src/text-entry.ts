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
 * inputs still allow e.g. Alt tab-switching chords. Shortcuts must explicitly
 * opt in to handling keys inside a shell or editor.
 */
export function isEditorOrTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('.xterm, .monaco-editor');
}

/**
 * isTextEntryTarget for a handler that itself sits on a dialog-like surface
 * (a temporary drawer's paper is role="dialog"): that surface does not
 * count, but typing targets and dialogs or menus opened from it still do.
 */
export function isTextEntryTargetWithin(target: EventTarget | null, surface: Element): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const modal = target.closest('[role="dialog"], [role="menu"], [role="listbox"]');
  if (modal && modal !== surface) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)) return true;
  return (
    target.isContentEditable ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    !!target.closest('[contenteditable="true"], [role="textbox"], .monaco-editor, .xterm')
  );
}
