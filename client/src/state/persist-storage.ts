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
    return (desktopStorage() ?? browserStorage())?.getItem(name) ?? null;
  },
  setItem(name, value) {
    (desktopStorage() ?? browserStorage())?.setItem(name, value);
  },
  removeItem(name) {
    (desktopStorage() ?? browserStorage())?.removeItem(name);
  },
};

/** Avoid cross-window broadcasts when a local-only store action partializes to identical shared data. */
export function skipUnchangedStorageWrites(base: StateStorage): StateStorage {
  return {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      const current = base.getItem(name);
      if (current instanceof Promise) {
        return current.then((resolved) => resolved === value ? undefined : base.setItem(name, value));
      }
      return current === value ? undefined : base.setItem(name, value);
    },
    removeItem: (name) => base.removeItem(name),
  };
}
