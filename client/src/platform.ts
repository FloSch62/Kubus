/** True on macOS — the desktop app reports the real platform; browsers are sniffed. */
export const IS_MAC = window.kubusDesktop ? window.kubusDesktop.platform === 'darwin' : /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** True on Windows — used where copied commands must follow the host shell's quoting rules. */
export const IS_WINDOWS = window.kubusDesktop ? window.kubusDesktop.platform === 'win32' : navigator.platform.startsWith('Win');

/** Prefix for rendering a mod-key shortcut inline, e.g. "⌘1" / "Ctrl+1". */
export const HOTKEY_MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';

/** The mod key as a standalone key cap, e.g. in the shortcut cheatsheet. */
export const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl';
