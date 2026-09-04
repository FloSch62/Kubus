import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const value = {
    apiFetch: vi.fn(),
    reconnectNow: vi.fn(),
    queryClient: { invalidateQueries: vi.fn(() => Promise.resolve()) },
  };
  Reflect.set(globalThis, Symbol.for('kubus.test.query-harness'), value);
  return value;
});

vi.mock('../../../client/src/api/http.js', () => ({ apiFetch: harness.apiFetch }));
vi.mock('../../../client/src/api/ws/watch-client.js', () => ({
  watchClient: { reconnectNow: harness.reconnectNow },
}));

import { BackendStatusBanner } from '../../../client/src/components/BackendStatusBanner';
import {
  dismissAuthInvalid,
  reportAuthInvalid,
  reportAuthValid,
  reportBackendDown,
  useBackendStore,
} from '../../../client/src/state/backend';

const SESSION_TEXT = 'Session is no longer valid';
const RETRY_TEXT = 'Backend connection lost';

beforeEach(() => {
  useBackendStore.setState({ unreachable: false, authInvalid: false, authInvalidDismissed: false });
  harness.apiFetch.mockReset().mockResolvedValue({});
  harness.reconnectNow.mockClear();
  harness.queryClient.invalidateQueries.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BackendStatusBanner', () => {
  it('renders nothing while the backend is healthy', () => {
    render(<BackendStatusBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the session notice with a close button that hides it', async () => {
    render(<BackendStatusBanner />);
    act(() => reportAuthInvalid());
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_TEXT);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useBackendStore.getState().authInvalidDismissed).toBe(true);
    // The notice keeps its text while the snackbar fades out.
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_TEXT);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps a dismissed notice hidden while the same session keeps failing', async () => {
    render(<BackendStatusBanner />);
    act(() => reportAuthInvalid());
    act(() => dismissAuthInvalid());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    // Repeated rejections from the ongoing polling must not resurface it.
    act(() => reportAuthInvalid());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides the session notice once the server accepts the token again and shows it anew on a fresh rejection', async () => {
    render(<BackendStatusBanner />);
    act(() => reportAuthInvalid());
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_TEXT);

    act(() => reportAuthValid());
    // Still the session text while fading, never the retry notice.
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_TEXT);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    act(() => reportAuthInvalid());
    act(() => dismissAuthInvalid());
    act(() => reportAuthValid());
    act(() => reportAuthInvalid());
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_TEXT);
  });

  it('shows the retry notice without a close button while the server is unreachable', () => {
    render(<BackendStatusBanner />);
    act(() => reportBackendDown());
    expect(screen.getByRole('alert')).toHaveTextContent(RETRY_TEXT);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('prefers the retry notice when the server drops while the session was already flagged', () => {
    render(<BackendStatusBanner />);
    act(() => {
      reportAuthInvalid();
      reportBackendDown();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(RETRY_TEXT);
  });

  it('probes the server while the session is flagged and snaps the app back once it answers', async () => {
    vi.useFakeTimers();
    render(<BackendStatusBanner />);
    act(() => reportAuthInvalid());
    expect(harness.apiFetch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(harness.apiFetch).toHaveBeenCalledWith('/api/app/info');
    expect(harness.reconnectNow).toHaveBeenCalledTimes(1);
    expect(harness.queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('stops probing once the session is accepted again', async () => {
    vi.useFakeTimers();
    render(<BackendStatusBanner />);
    act(() => reportAuthInvalid());
    act(() => reportAuthValid());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(harness.apiFetch).not.toHaveBeenCalled();
  });
});
