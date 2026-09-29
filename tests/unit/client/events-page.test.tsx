import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import { EventsPage } from '../../../client/src/pages/EventsPage';
import { useClustersStore } from '../../../client/src/state/clusters';
import { useEventsPrefsStore } from '../../../client/src/state/events-prefs';

const fixtures = vi.hoisted(() => ({ rows: [] as Array<{ ctx: string; obj: unknown }> }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useApiResourcesForContexts: () => ({ data: undefined }),
  useWatchedList: () => ({ rows: fixtures.rows, status: { 'kind-a': { state: 'live' } } }),
}));
vi.mock('../../../client/src/components/CellCopy.js', () => ({
  CellCopyOverlay: () => null,
  copyCellGridSx: {},
  handleCopyCellKeyDown: vi.fn(),
  withCellCopy: (column: unknown) => column,
}));
vi.mock('../../../client/src/components/grid-prefs.js', () => ({
  useGridPrefs: (_id: string, columns: unknown[]) => ({ columns, density: 'compact', onColumnWidthChange: vi.fn() }),
}));
vi.mock('../../../client/src/components/SmartFilterInput.js', () => ({ SmartFilterInput: () => null }));

let seq = 0;
function event(type: string, reason: string, name: string, count = 1): { ctx: string; obj: KubeObject } {
  seq += 1;
  const now = new Date().toISOString();
  return {
    ctx: 'kind-a',
    obj: {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: `e${seq}`, namespace: 'demo', uid: `u${seq}`, creationTimestamp: now },
      type,
      reason,
      message: `${reason} message`,
      count,
      firstTimestamp: now,
      lastTimestamp: now,
      involvedObject: { kind: 'Pod', name, namespace: 'demo', uid: `pod-${name}` },
    } as unknown as KubeObject,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <EventsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useClustersStore.setState({ selected: ['kind-a'], namespaces: [], namespacesByContext: {} });
  useEventsPrefsStore.setState({ scope: 'warnings', grouping: 'object' });
  fixtures.rows = [event('Warning', 'Failed', 'broken', 10), event('Normal', 'BackOff', 'broken', 12), event('Normal', 'Pulled', 'healthy')];
});

describe('EventsPage', () => {
  it('opens on warnings, one row per object, with the Normal events folded in', () => {
    renderPage();

    expect(screen.getByRole('button', { name: /Warnings\s*1 objects/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'broken' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'healthy' })).not.toBeInTheDocument();
    expect(screen.getByText('Also: BackOff ×12')).toBeInTheDocument();
    // No Type column in the grouped view.
    expect(screen.queryByRole('columnheader', { name: 'Type' })).not.toBeInTheDocument();
  });

  it('shows every object under All and remembers the choice', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));

    expect(screen.getByRole('button', { name: 'healthy' })).toBeInTheDocument();
    expect(useEventsPrefsStore.getState().scope).toBe('all');
  });

  it('switches to the flat event log with its Type column', () => {
    useEventsPrefsStore.setState({ grouping: 'flat' });
    renderPage();

    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
    const grid = screen.getByRole('grid');
    // Warnings scope: the Normal events stay out of the flat log too.
    expect(within(grid).getAllByText('Failed')).toHaveLength(1);
    expect(within(grid).queryByText('BackOff')).not.toBeInTheDocument();
  });

  it('points to All when there are no warnings', () => {
    fixtures.rows = [event('Normal', 'Pulled', 'healthy')];
    renderPage();
    expect(screen.getByText('No warnings. Switch to All to see every event.')).toBeInTheDocument();
  });
});
