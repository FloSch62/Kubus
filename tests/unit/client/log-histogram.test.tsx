import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectLevel } from '../../../client/src/components/log-format';
import { LogHistogram } from '../../../client/src/components/LogHistogram';
import { logLine, type LogEntry, type LogLine } from '../../../client/src/components/log-tools';

const levelOf = (line: LogLine) => detectLevel(line.line);
const colors = { error: 'red', warn: 'orange', info: 'blue', debug: 'grey', trace: 'grey', none: 'silver' };
const markerColors = { manual: 'purple', warning: 'orange', success: 'green', joined: 'teal', left: 'grey' };
const WIDTH = 700;

class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: WIDTH } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

const entries: LogEntry[] = [
  logLine('web-a', 'app', 'INFO start', '2026-07-22T12:00:00Z', 0),
  logLine('web-a', 'app', 'ERROR boom', '2026-07-22T12:00:30Z', 0),
  logLine('web-a', 'app', 'WARN slow', '2026-07-22T12:01:39Z', 0),
];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: WIDTH, height: 24, right: WIDTH, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LogHistogram', () => {
  function renderStrip(onJump = vi.fn()) {
    const view = render(
      <LogHistogram entries={entries} levelOf={levelOf} colors={colors} markerColors={markerColors} formatTime={(ms) => new Date(ms).toISOString().slice(11, 19)} onJump={onJump} />,
    );
    return { view, onJump, strip: screen.getByLabelText(/^Log volume/) };
  }

  it('draws stacked bars and labels the time range', () => {
    const { view, strip } = renderStrip();
    expect(strip).toHaveAccessibleName('Log volume, 1 s per bar, 12:00:00 to 12:01:40. Click a bar to jump to that moment.');
    expect(screen.getByText('1 s per bar')).toBeInTheDocument();
    const fills = [...view.container.querySelectorAll('rect')].map((rect) => rect.getAttribute('fill'));
    expect(fills).toEqual(['blue', 'red', 'orange']);
  });

  it('jumps to the first line of a clicked bar, and by keyboard', () => {
    const { onJump, strip } = renderStrip();
    fireEvent.click(strip, { clientX: WIDTH - 1 });
    expect(onJump).toHaveBeenLastCalledWith(2);
    // An empty bar has nowhere to go.
    fireEvent.click(strip, { clientX: WIDTH / 2 });
    expect(onJump).toHaveBeenCalledTimes(1);
    act(() => {
      fireEvent.keyDown(strip, { key: 'ArrowRight' });
    });
    fireEvent.keyDown(strip, { key: 'Enter' });
    expect(onJump).toHaveBeenLastCalledWith(0);
  });

  it('says so when there are no lines', () => {
    render(<LogHistogram entries={[]} levelOf={levelOf} colors={colors} markerColors={markerColors} formatTime={String} onJump={vi.fn()} />);
    expect(screen.getByText('No lines yet')).toBeInTheDocument();
  });
});
