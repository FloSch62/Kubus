import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UsageRanking } from '../../../client/src/components/UsageRanking';

const format = (v: number) => `${v} B/s`;

describe('UsageRanking', () => {
  it('prints a single value per row by default', () => {
    render(<UsageRanking rows={[{ key: 'a', name: 'web', detail: 'demo', values: [30] }]} colors={['#111']} format={format} />);
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('30 B/s')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sent')).not.toBeInTheDocument();
  });

  it('prints each named part under the total and names them on hover', async () => {
    render(
      <UsageRanking
        rows={[{ key: 'a', name: 'web', detail: 'demo', values: [12, 30] }]}
        colors={['#111', '#222']}
        parts={[
          { label: 'Sent', mark: '↑' },
          { label: 'Received', mark: '↓' },
        ]}
        format={format}
      />,
    );
    expect(screen.getByText('42 B/s')).toBeInTheDocument();
    expect(screen.getByLabelText('Sent')).toHaveTextContent('↑');
    expect(screen.getByLabelText('Received')).toHaveTextContent('↓');
    expect(screen.getByText(/12 B\/s/)).toBeInTheDocument();

    const bar = screen.getByText('42 B/s').closest('li')!.children[1]!;
    fireEvent.mouseOver(bar);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Sent12 B/sReceived30 B/s');
  });
});
