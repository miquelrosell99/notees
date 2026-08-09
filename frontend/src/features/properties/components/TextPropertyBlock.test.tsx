/**
 * TextPropertyBlock tests.
 *
 * Covers the ghost-block empty state, owner-child block creation, and the
 * "root block" rendering fix that makes the block content visible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextPropertyBlock } from './TextPropertyBlock';
import type { Property } from '@/types/api';
import type * as ContentModule from '@/features/content';
import type * as ReactRouterModule from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  newBlockUuid: 'new-block-uuid',
  createBlock: vi.fn().mockResolvedValue('new-block-uuid'),
  node: null as unknown,
  nodeCollectionProps: null as Record<string, unknown> | null,
}));

vi.mock('@/features/content', async () => {
  const actual = await vi.importActual('@/features/content') as typeof ContentModule;
  return {
    ...actual,
    useNode: () => ({ data: mocks.node, isLoading: false, error: null }),
    useNodeNavigation: () => ({ handleNodeClick: vi.fn() }),
    useCoreBlockMutations: () => ({ createBlock: mocks.createBlock }),
    NodeCollection: (props: Record<string, unknown>) => {
      mocks.nodeCollectionProps = props;
      return <div data-testid="node-collection">NodeCollection</div>;
    },
  };
});

vi.mock('@/features/editor', () => ({
  useContentSave: () => ({ handleContentChange: vi.fn() }),
}));

vi.mock('@/api/client', () => ({
  isApiError: () => false,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom') as typeof ReactRouterModule;
  return {
    ...actual,
    useParams: () => ({ workspaceId: 'workspace-1' }),
  };
});

function makeProperty(partial: Partial<Property> = {}): Property {
  return {
    uuid: 'prop-text',
    name: 'Text Prop',
    type: 'text',
    multi: false,
    icon_visibility: null,
    required: false,
    readonly: false,
    hide_when_empty: false,
    default_value: null,
    ...partial,
  } as unknown as Property;
}

beforeEach(() => {
  mocks.createBlock.mockClear();
  mocks.node = null;
  mocks.nodeCollectionProps = null;
});

describe('TextPropertyBlock', () => {
  it('renders a ghost block when the single text property is empty', () => {
    render(
      <TextPropertyBlock
        property={makeProperty()}
        nodeUuid="owner-uuid"
        blockNodeId={null}
        onPropertyChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Add text' })).toBeInTheDocument();
    expect(screen.getByText('+ Add text')).toBeInTheDocument();
  });

  it('creates a child block of the owner node and sets the property value when the ghost is clicked', async () => {
    const onPropertyChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TextPropertyBlock
        property={makeProperty()}
        nodeUuid="owner-uuid"
        blockNodeId={null}
        onPropertyChange={onPropertyChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add text' }));

    await vi.waitFor(() => {
      expect(mocks.createBlock).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createBlock).toHaveBeenCalledWith({ parentId: 'owner-uuid', contentAST: [] });
    expect(onPropertyChange).toHaveBeenCalledWith('prop-text', mocks.newBlockUuid);
  });

  it('renders the assigned block as the root block of a normal block list view', () => {
    mocks.node = {
      uuid: 'block-uuid',
      name: 'Block content',
      content: 'Block content',
      parent_uuid: 'owner-uuid',
      is_page: false,
      properties_uuid: {},
    };

    render(
      <TextPropertyBlock
        property={makeProperty()}
        nodeUuid="owner-uuid"
        blockNodeId="block-uuid"
        onPropertyChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('node-collection')).toBeInTheDocument();
    expect(mocks.nodeCollectionProps).toMatchObject({
      nodeUuid: 'block-uuid',
      rootIsBlock: true,
      showNewBlock: true,
      hideRootBullet: true,
    });
  });

  it('renders a ghost block for an empty multi-value text property', () => {
    render(
      <TextPropertyBlock
        property={makeProperty({ multi: true })}
        nodeUuid="owner-uuid"
        blockNodeId={null}
        blockNodeIds={[]}
        onPropertyChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Add text' })).toBeInTheDocument();
  });

  it('appends a new child block of the owner node when the trailing ghost is clicked in multi mode', async () => {
    const onPropertyChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TextPropertyBlock
        property={makeProperty({ multi: true })}
        nodeUuid="owner-uuid"
        blockNodeId={null}
        blockNodeIds={['existing-uuid']}
        onPropertyChange={onPropertyChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add text' }));

    await vi.waitFor(() => {
      expect(mocks.createBlock).toHaveBeenCalledTimes(1);
    });
    expect(onPropertyChange).toHaveBeenCalledWith('prop-text', ['existing-uuid', mocks.newBlockUuid]);
  });
});
