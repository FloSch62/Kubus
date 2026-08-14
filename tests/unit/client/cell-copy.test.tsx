import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CellCopyOverlay } from '../../../client/src/components/CellCopy';

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));

vi.mock('../../../client/src/clipboard.js', () => ({ copyToClipboard: clipboard.copy }));

function GridHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef}>
      <div className="MuiDataGrid-virtualScroller">
        <div className="MuiDataGrid-cell">
          <span data-copy-text="first-raw">First</span>
        </div>
        <div className="MuiDataGrid-cell">
          <span data-copy-text="second-raw">Second</span>
        </div>
      </div>
      <CellCopyOverlay rootRef={rootRef} />
    </div>
  );
}

describe('CellCopyOverlay', () => {
  it('mounts one button for the hovered cell and removes it while scrolling', async () => {
    const { container } = render(<GridHarness />);

    fireEvent.pointerOver(screen.getByText('First'));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy value' }));
    expect(clipboard.copy).toHaveBeenCalledWith('first-raw');

    fireEvent.pointerOver(screen.getByText('Second'));
    expect(screen.getAllByRole('button', { name: 'Copy value' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(clipboard.copy).toHaveBeenLastCalledWith('second-raw');

    fireEvent.scroll(container.querySelector('.MuiDataGrid-virtualScroller')!);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy value' })).not.toBeInTheDocument());
  });

  it('copies the current value when a hovered cell updates', async () => {
    render(<GridHarness />);

    fireEvent.pointerOver(screen.getByText('First'));
    const value = screen.getByText('First');
    value.dataset.copyText = 'updated-raw';
    fireEvent.click(await screen.findByRole('button', { name: 'Copy value' }));

    expect(clipboard.copy).toHaveBeenLastCalledWith('updated-raw');
  });
});
