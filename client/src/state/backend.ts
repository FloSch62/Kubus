import { create } from 'zustand';

interface BackendState {
  /** The local Kubus server did not answer a fetch at all. */
  unreachable: boolean;
  /** The server answered 401 — the session token is no longer valid. */
  authInvalid: boolean;
  /**
   * The user closed the invalid-session banner. Cleared as soon as the server
   * accepts the token again, so a later rejection surfaces the banner anew.
   */
  authInvalidDismissed: boolean;
}

export const useBackendStore = create<BackendState>()(() => ({
  unreachable: false,
  authInvalid: false,
  authInvalidDismissed: false,
}));

export function reportBackendDown(): void {
  if (!useBackendStore.getState().unreachable) useBackendStore.setState({ unreachable: true });
}

export function reportBackendUp(): void {
  if (useBackendStore.getState().unreachable) useBackendStore.setState({ unreachable: false });
}

export function reportAuthInvalid(): void {
  if (!useBackendStore.getState().authInvalid) useBackendStore.setState({ authInvalid: true });
}

/** Any response the server did not reject as a session failure proves the token still works. */
export function reportAuthValid(): void {
  const { authInvalid, authInvalidDismissed } = useBackendStore.getState();
  if (authInvalid || authInvalidDismissed) useBackendStore.setState({ authInvalid: false, authInvalidDismissed: false });
}

export function dismissAuthInvalid(): void {
  if (!useBackendStore.getState().authInvalidDismissed) useBackendStore.setState({ authInvalidDismissed: true });
}
