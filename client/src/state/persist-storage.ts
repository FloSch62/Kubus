import type { StateStorage } from 'zustand/middleware';

function desktopStorage() {
  return typeof window === 'undefined' ? undefined : window.kubusDesktop?.stateStorage;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const kubusStateStorage: StateStorage = {
  getItem(name) {
    const desktop = desktopStorage();
    if (desktop) {
      try {
        const value = desktop.getItem(name);
        if (value !== null) return value;
      } catch {
        /* fall back to browser storage */
      }
    }

    const value = browserStorage()?.getItem(name) ?? null;
    if (desktop && value !== null) {
      try {
        desktop.setItem(name, value);
      } catch {
        /* best-effort migration from origin-scoped storage */
      }
    }
    return value;
  },
  setItem(name, value) {
    const desktop = desktopStorage();
    if (desktop) {
      try {
        desktop.setItem(name, value);
        return;
      } catch {
        /* fall back to browser storage */
      }
    }
    browserStorage()?.setItem(name, value);
  },
  removeItem(name) {
    const desktop = desktopStorage();
    if (desktop) {
      try {
        desktop.removeItem(name);
      } catch {
        /* also clear browser storage below */
      }
    }
    browserStorage()?.removeItem(name);
  },
};
