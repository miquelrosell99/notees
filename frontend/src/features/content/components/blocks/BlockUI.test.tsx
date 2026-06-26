/**
 * BlockUI tests — verify live-sync chrome (locks, presence, queue, conflict).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BlockUI } from './BlockUI';
import type { Node } from '@/types/api';

const baseNode: Node = {
  uuid: 'block-a',
  name: 'Hello',
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  collapsed: false,
  active: true,
  is_page: false,
  create_date: '',
  write_date: '',
};

describe('BlockUI', () => {
  it('renders a lock indicator when another user holds the lock', () => {
    render(
      <BlockUI
        node={baseNode}
        lockedBy={[{ nodeUuid: 'user-2', name: 'Alice', color: '#ef4444' }]}
      />,
    );

    expect(screen.getByTitle(/Editing by Alice/i)).toBeInTheDocument();
  });

  it('renders presence avatars for remote users', () => {
    render(
      <BlockUI
        node={baseNode}
        presenceUsers={[{ nodeUuid: 'user-2', name: 'Alice', color: '#ef4444' }]}
      />,
    );

    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders a request-to-edit button when the block is locked', () => {
    const onRequestLock = vi.fn();
    render(
      <BlockUI
        node={baseNode}
        lockedBy={[{ nodeUuid: 'user-2', name: 'Alice', color: '#ef4444' }]}
        onRequestLock={onRequestLock}
      />,
    );

    const button = screen.getByRole('button', { name: /Request to edit/i });
    expect(button).toBeInTheDocument();
    button.click();
    expect(onRequestLock).toHaveBeenCalled();
  });

  it('renders a queue indicator when the local user is waiting', () => {
    render(<BlockUI node={baseNode} isQueued />);

    expect(screen.getByTitle(/Waiting to edit/i)).toBeInTheDocument();
  });

  it('renders a conflict banner with a refresh action', () => {
    const onResolveConflict = vi.fn();
    render(
      <BlockUI
        node={baseNode}
        conflict={{ reason: 'lock_lost' }}
        onResolveConflict={onResolveConflict}
      />,
    );

    expect(screen.getByText(/This block was edited by someone else/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Refresh/i });
    button.click();
    expect(onResolveConflict).toHaveBeenCalled();
  });

  it('does not render the request button when already queued', () => {
    render(
      <BlockUI
        node={baseNode}
        lockedBy={[{ nodeUuid: 'user-2', name: 'Alice', color: '#ef4444' }]}
        isQueued
        onRequestLock={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Request to edit/i })).not.toBeInTheDocument();
  });
});
