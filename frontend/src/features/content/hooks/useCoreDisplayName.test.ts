/**
 * Tests for useCoreDisplayName.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { renderHook } from '@testing-library/react';
import { useCoreDisplayName } from './useCoreDisplayName';
import type { NodeRow } from '@/core/store';
import type { BatchGetNodesByUuidResponse } from '@/types/api';
import type { Node } from '@/types';

const mocks = vi.hoisted(() => ({
  useNode: vi.fn(() => ({ node: undefined as NodeRow | undefined, isLoading: false, error: null })),
  useBatchNodesByUuid: vi.fn(() => ({ data: undefined as BatchGetNodesByUuidResponse | undefined, isLoading: false, error: null })),
}));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ workspaceId: 'ws-test' })),
}));

vi.mock('@/core/hooks', () => ({
  useNode: mocks.useNode,
}));

vi.mock('@/features/content/hooks/useBatchNodesByUuid', () => ({
  useBatchNodesByUuid: mocks.useBatchNodesByUuid,
}));

describe('useCoreDisplayName', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  beforeEach(() => {
    mocks.useNode.mockReturnValue({ node: undefined, isLoading: false, error: null });
    mocks.useBatchNodesByUuid.mockReturnValue({ data: undefined, isLoading: false, error: null });
  });

  it('returns plain text for text-only content', () => {
    mocks.useNode.mockReturnValue({
      node: {
        id: 'node-1',
        content: JSON.stringify([
          { type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] },
        ]),
      } as unknown as NodeRow,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useCoreDisplayName('node-1', ''));
    expect(result.current).toBe('Hello world');
  });

  it('returns fallback when content is empty', () => {
    mocks.useNode.mockReturnValue({
      node: { id: 'node-1', content: '' } as unknown as NodeRow,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useCoreDisplayName('node-1', 'Fallback'));
    expect(result.current).toBe('Fallback');
  });

  it('resolves node links to target node content instead of showing "…"', () => {
    mocks.useNode.mockReturnValue({
      node: {
        id: 'node-with-link',
        content: JSON.stringify([
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'See ' },
              { type: 'node_link', link_id: 'target-node', ref_type: 'node' },
            ],
          },
        ]),
      } as unknown as NodeRow,
      isLoading: false,
      error: null,
    });

    mocks.useBatchNodesByUuid.mockReturnValue({
      data: {
        nodes: {
          'target-node': {
            uuid: 'target-node',
            content: JSON.stringify([
              { type: 'paragraph', children: [{ type: 'text', text: 'Target page' }] },
            ]),
          } as unknown as Node,
        },
      },
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useCoreDisplayName('node-with-link', ''));
    expect(result.current).not.toBe('See …');
    expect(result.current).toBe('See Target page');
  });

  it('resolves node links saved via setNodeText (JSON-wrapped CRDT content)', () => {
    // This mirrors the inline editor save path: the real AST is serialized to
    // JSON and stored as the plaintext of a single text node.
    const realAst = JSON.stringify([
      {
        type: 'paragraph',
        children: [{ type: 'node_link', link_id: 'wrapped-target', ref_type: 'node' }],
      },
    ]);
    mocks.useNode.mockReturnValue({
      node: {
        id: 'node-with-wrapped-link',
        content: JSON.stringify([{ type: 'text', text: realAst }]),
      } as unknown as NodeRow,
      isLoading: false,
      error: null,
    });

    mocks.useBatchNodesByUuid.mockReturnValue({
      data: {
        nodes: {
          'wrapped-target': {
            uuid: 'wrapped-target',
            content: JSON.stringify([
              { type: 'paragraph', children: [{ type: 'text', text: 'GMI Dental Implantology, S.L.' }] },
            ]),
          } as unknown as Node,
        },
      },
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useCoreDisplayName('node-with-wrapped-link', ''));
    expect(result.current).not.toBe('…');
    expect(result.current).not.toContain('[');
    expect(result.current).toBe('GMI Dental Implantology, S.L.');
  });
});
