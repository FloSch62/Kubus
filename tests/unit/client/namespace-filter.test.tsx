import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NamespaceFilter, namespaceFilterSx } from '../../../client/src/layout/NamespaceFilter';
import { useClustersStore } from '../../../client/src/state/clusters';

const queryMocks = vi.hoisted(() => ({ namespaces: ['default', 'kube-system'] }));

vi.mock('../../../client/src/api/queries.js', () => ({
  useNamespaces: () => ({ data: queryMocks.namespaces }),
}));

beforeEach(() => {
  useClustersStore.setState({ selected: ['test'], namespaces: [] });
});

describe('NamespaceFilter', () => {
  it('makes the complete autocomplete a non-draggable title-bar region', () => {
    render(<NamespaceFilter />);

    const input = screen.getByPlaceholderText('All namespaces');
    const root = input.closest('.MuiAutocomplete-root');
    expect(root).not.toBeNull();
    expect(namespaceFilterSx.WebkitAppRegion).toBe('no-drag');
  });

  it('does not render without a selected cluster', () => {
    useClustersStore.setState({ selected: [] });
    const { container } = render(<NamespaceFilter />);
    expect(container).toBeEmptyDOMElement();
  });
});
