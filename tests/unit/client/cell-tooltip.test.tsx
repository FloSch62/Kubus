import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CellTooltip, GridTooltips } from '../../../client/src/components/CellTooltip';

function Table({ title = 'Current usage', show = true }: { title?: string; show?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} data-testid="table">
    <GridTooltips rootRef={ref}>
      {show && <CellTooltip title={title} enterDelay={10}><button>Usage</button></CellTooltip>}
      <CellTooltip title="Resource age" enterDelay={10}><button>Age</button></CellTooltip>
    </GridTooltips>
  </div>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, top: 10, left: 10, bottom: 30, right: 110, width: 100, height: 20, toJSON: () => ({}) });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function hover(name: string) {
  fireEvent.pointerOver(screen.getByRole('button', { name }));
  await act(() => vi.advanceTimersByTimeAsync(20));
}

describe('shared table tooltips', () => {
  it('keeps one tooltip, follows live cell values and hides when the row is recycled', async () => {
    const view = render(<Table />);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await hover('Usage');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current usage');
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    view.rerender(<Table title="Updated usage" />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Updated usage');
    view.rerender(<Table show={false} />);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await hover('Age');
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Resource age');
    fireEvent.scroll(screen.getByTestId('table'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Age' })).not.toHaveAttribute('aria-describedby');
  });

  it('supports keyboard focus and cancels pending hover work when scrolling starts', async () => {
    render(<Table />);
    fireEvent.pointerOver(screen.getByRole('button', { name: 'Usage' }));
    fireEvent.scroll(screen.getByTestId('table'));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.focusIn(screen.getByRole('button', { name: 'Age' }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Resource age');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
