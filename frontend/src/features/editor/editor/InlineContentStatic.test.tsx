/**
 * InlineContentStatic tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InlineContentStatic } from './InlineContentStatic';
import { getLogicalOffsetFromPoint } from './utils/cursorOffsetFromPoint';

vi.mock('./utils/cursorOffsetFromPoint', () => ({
  getLogicalOffsetFromPoint: vi.fn(),
}));

const baseName = JSON.stringify([
  { type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] },
]);

const emptyName = JSON.stringify([]);

const nameWithLink = JSON.stringify([
  {
    type: 'paragraph',
    children: [
      { type: 'text', text: 'See ' },
      { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
    ],
  },
]);

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('InlineContentStatic', () => {
  it('renders static text content', () => {
    render(<InlineContentStatic name={baseName} blockId="b1" />, { wrapper: Wrapper });
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('shows placeholder when content is empty', () => {
    render(<InlineContentStatic name={emptyName} blockId="b1" placeholder="Type something" />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Type something')).toBeInTheDocument();
  });

  it('calls onFocus with a cursor offset when clicked', () => {
    const onFocus = vi.fn();
    vi.mocked(getLogicalOffsetFromPoint).mockReturnValue(6);
    render(<InlineContentStatic name={baseName} blockId="b1" onFocus={onFocus} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Hello world'));
    expect(onFocus).toHaveBeenCalledWith(6);
  });

  it('calls onFocus when Enter is pressed', () => {
    const onFocus = vi.fn();
    render(<InlineContentStatic name={baseName} blockId="b1" onFocus={onFocus} />, { wrapper: Wrapper });
    fireEvent.keyDown(screen.getByText('Hello world'), { key: 'Enter' });
    expect(onFocus).toHaveBeenCalled();
  });

  it('renders a node link', () => {
    render(<InlineContentStatic name={nameWithLink} blockId="b1" />, { wrapper: Wrapper });
    expect(screen.getByText('See')).toBeInTheDocument();
    // The NodeRef inline variant renders the resolved node name; with no data
    // it falls back to a truncated UUID label.
    expect(screen.getByText(/node…/i)).toBeInTheDocument();
  });
});
