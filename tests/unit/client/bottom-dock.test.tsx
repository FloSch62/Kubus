import { fireEvent, render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomDock } from '../../../client/src/layout/BottomDock';
import { useDockStore, type DockTab, type NodeShellTab, type TerminalTab } from '../../../client/src/state/dock';

vi.mock('../../../client/src/components/TerminalPane.js', () => ({
  TerminalPane: ({ tab, reconnectRequest }: { tab: TerminalTab | NodeShellTab; reconnectRequest: number }) => (
    <div data-testid={`terminal-${tab.id}`} data-reconnect-request={reconnectRequest} />
  ),
}));

vi.mock('../../../client/src/components/LogViewer.js', () => ({
  LogViewer: () => <div data-testid="log-viewer" />,
}));

const terminal: DockTab = {
  kind: 'terminal',
  id: 'terminal',
  title: 'shell',
  ctx: 'kind-a',
  namespace: 'default',
  pod: 'web',
  container: 'web',
};
const logs: DockTab = {
  kind: 'logs',
  id: 'logs',
  title: 'logs',
  ctx: 'kind-a',
  namespace: 'default',
  pods: ['web'],
};

beforeEach(() => {
  useDockStore.setState({
    tabs: [terminal, logs],
    activeId: terminal.id,
    open: true,
    maximized: false,
    terminalFocusRequest: undefined,
    terminalReconnectRequests: {},
  });
});

describe('BottomDock terminal tab menu', () => {
  it('renders a focused utility shell without app-dock window controls', () => {
    const { container } = render(<BottomDock containerRef={{ current: document.createElement('div') }} standalone />);

    expect(container.querySelector('.kubus-dock-window-titlebar')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Maximize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
    expect(screen.getByTestId(`terminal-${terminal.id}`)).toBeVisible();
  });

  it('requests a new terminal connection from the right-click menu', () => {
    render(<BottomDock containerRef={{ current: document.createElement('div') }} />);

    fireEvent.contextMenu(screen.getByRole('tab', { name: /shell/ }), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reconnect' }));

    expect(useDockStore.getState().terminalReconnectRequests).toEqual({ [terminal.id]: 1 });
    expect(screen.getByTestId(`terminal-${terminal.id}`)).toHaveAttribute('data-reconnect-request', '1');
  });

  it('does not show reconnect for log tabs', () => {
    render(<BottomDock containerRef={{ current: document.createElement('div') }} />);

    fireEvent.contextMenu(screen.getByRole('tab', { name: /logs/ }), { clientX: 24, clientY: 36 });

    expect(screen.queryByRole('menuitem', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open in new window' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Move to new window' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Close tabs to the right' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('renames and flags terminal tabs from the shared menu', async () => {
    render(<BottomDock containerRef={{ current: document.createElement('div') }} />);

    fireEvent.contextMenu(screen.getByRole('tab', { name: /shell/ }), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename tab' }));
    const input = screen.getByRole('textbox', { name: 'Tab name' });
    fireEvent.change(input, { target: { value: 'API shell' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(useDockStore.getState().tabs[0]?.title).toBe('API shell');
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));

    fireEvent.contextMenu(screen.getByRole('tab', { name: /API shell/ }), { clientX: 24, clientY: 36 });
    fireEvent.click(screen.getByRole('button', { name: 'Flag tab #42a5f5' }));
    expect(useDockStore.getState().tabs[0]?.color).toBe('#42a5f5');
  });
});
