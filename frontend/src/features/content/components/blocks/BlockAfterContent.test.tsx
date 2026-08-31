/**
 * BlockAfterContent whiteboard dispatch tests (Decision 24).
 *
 * A block with the `whiteboard` system class renders the shared WhiteboardView
 * in inline mode among its siblings; plain blocks and collapsed blocks do not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useUIStateStore } from '@/features/sync';
import type { Node } from '@/types/api';

const whiteboardViewSpy = vi.fn();

vi.mock('@/features/whiteboard', () => ({
  WhiteboardView: (props: { nodeUuid: string; inline?: boolean }) => {
    whiteboardViewSpy(props);
    return (
      <div
        data-testid="inline-whiteboard"
        data-node-uuid={props.nodeUuid}
        data-inline={String(props.inline === true)}
      />
    );
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...(actual as object), useParams: () => ({ workspaceId: 'ws-1' }) };
});

import { BlockAfterContent } from './BlockAfterContent';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    uuid: 'block-1',
    name: JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: '' }] }]),
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    classes_uuid: [],
    tags_uuid: [],
    properties_uuid: {},
    create_date: '',
    write_date: '',
    ...overrides,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('BlockAfterContent — whiteboard dispatch', () => {
  beforeEach(() => {
    whiteboardViewSpy.mockClear();
    useUIStateStore.setState({ states: {} });
  });

  it('renders the shared whiteboard view inline for a whiteboard-classed block', async () => {
    const node = makeNode({ classes_uuid: [SYSTEM_CLASS_UUIDS.whiteboard] });
    render(<BlockAfterContent node={node} />, { wrapper: Wrapper });

    const card = await screen.findByTestId('inline-whiteboard');
    expect(card).toHaveAttribute('data-node-uuid', 'block-1');
    expect(card).toHaveAttribute('data-inline', 'true');
    expect(whiteboardViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ nodeUuid: 'block-1', inline: true }),
    );
  });

  it('renders nothing extra for a plain block', () => {
    const { container } = render(<BlockAfterContent node={makeNode()} />, { wrapper: Wrapper });

    expect(screen.queryByTestId('inline-whiteboard')).not.toBeInTheDocument();
    expect(container.querySelector('.block-after-content')?.children).toHaveLength(0);
  });

  it('does not render the inline canvas while the block is collapsed', () => {
    useUIStateStore.setState({
      states: { 'ws-1': { 'block-1': { collapsed: true } } },
    } as never);
    const node = makeNode({ classes_uuid: [SYSTEM_CLASS_UUIDS.whiteboard] });
    render(<BlockAfterContent node={node} />, { wrapper: Wrapper });

    expect(screen.queryByTestId('inline-whiteboard')).not.toBeInTheDocument();
  });
});
