import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceStoreProvider } from '@/core/hooks/WorkspaceStoreProvider';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '@/core/transport';
import { uuidv7 } from '@/core/uuid';
import { useComments, useCreateComment } from '../useComments';
import { useUndoManager } from '@/core/hooks/useUndoManager';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import type { Node } from '@/types/api';
import type { WorkspaceStore } from '@/core/store';
import type { TextCrdt } from '@/core/crdt/text';

let mockEnableSqliteStore = false;

vi.mock('@/core/utils/featureFlags', () => ({
  get ENABLE_SQLITE_STORE() {
    return mockEnableSqliteStore;
  },
}));

function createProviderProps(workspaceId: string) {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, workspaceId);
  return { actorId, transport };
}

function sqliteWrapper(props: {
  workspaceId: string;
  actorId: string;
  transport: MemoryTransport;
}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/${props.workspaceId}`]}>
          <Routes>
            <Route
              path="/:workspaceId/*"
              element={
                <WorkspaceStoreProvider
                  actorId={props.actorId}
                  transport={props.transport}
                >
                  {children}
                </WorkspaceStoreProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

async function setupStore(workspaceId: string) {
  const props = createProviderProps(workspaceId);
  const Wrapper = sqliteWrapper({ ...props, workspaceId });

  const { result } = renderHook(() => useWorkspaceStore(workspaceId), {
    wrapper: Wrapper,
  });
  await waitFor(() => expect(result.current.store).toBeDefined());

  return { store: result.current.store!, Wrapper };
}

function createCommentNode(
  store: WorkspaceStore,
  parentId: string,
  name: string
): string {
  const commentId = uuidv7();
  store.createNode({
    nodeId: commentId,
    kind: 'block',
    parentId,
    classIds: [SYSTEM_CLASS_UUIDS.comment],
  });
  store.moveNode(commentId, parentId);
  store.updateText(commentId, (text: TextCrdt) => {
    const current = text.toPlaintext();
    text.delete(0, current.length);
    text.insert(0, name);
  });
  return commentId;
}

describe('useComments', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockEnableSqliteStore = false;
  });

  describe('when ENABLE_SQLITE_STORE is true', () => {
    beforeEach(() => {
      mockEnableSqliteStore = true;
    });

    it('useCreateComment creates a top-level comment under a node', async () => {
      const workspaceId = uuidv7();
      const { store, Wrapper } = await setupStore(workspaceId);

      const pageId = uuidv7();
      act(() => {
        store.createNode({ nodeId: pageId, kind: 'page', parentId: null });
      });

      const { result: createResult } = renderHook(
        () => {
          const create = useCreateComment();
          const manager = useUndoManager(workspaceId);
          return { create, manager };
        },
        { wrapper: Wrapper }
      );
      await waitFor(() => expect(createResult.current.manager).toBeDefined());

      let created: Node | undefined;
      await act(async () => {
        created = await createResult.current.create.mutateAsync({
          nodeUuid: pageId,
          name: 'Top-level comment',
        });
      });

      expect(created).toBeDefined();
      expect(created!.parent_uuid).toBe(pageId);
      expect(created!.classes_uuid).toContain(SYSTEM_CLASS_UUIDS.comment);
      expect(created!.name).toBe('Top-level comment');

      const { result: commentsResult } = renderHook(() => useComments(pageId), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(commentsResult.current.isLoading).toBe(false));
      expect(commentsResult.current.data?.comments).toHaveLength(1);
      expect(commentsResult.current.data?.comments[0].uuid).toBe(created!.uuid);
    });

    it('useCreateComment with parentCommentUuid creates a nested reply', async () => {
      const workspaceId = uuidv7();
      const { store, Wrapper } = await setupStore(workspaceId);

      const pageId = uuidv7();
      const parentCommentId = createCommentNode(store, pageId, 'Parent comment');

      const { result: createResult } = renderHook(
        () => {
          const create = useCreateComment();
          const manager = useUndoManager(workspaceId);
          return { create, manager };
        },
        { wrapper: Wrapper }
      );
      await waitFor(() => expect(createResult.current.manager).toBeDefined());

      let reply: Node | undefined;
      await act(async () => {
        reply = await createResult.current.create.mutateAsync({
          nodeUuid: pageId,
          parentCommentUuid: parentCommentId,
          name: 'Nested reply',
        });
      });

      expect(reply).toBeDefined();
      expect(reply!.parent_uuid).toBe(parentCommentId);
      expect(reply!.classes_uuid).toContain(SYSTEM_CLASS_UUIDS.comment);

      const { result: repliesResult } = renderHook(
        () => useComments(parentCommentId),
        { wrapper: Wrapper }
      );
      await waitFor(() => expect(repliesResult.current.isLoading).toBe(false));
      expect(repliesResult.current.data?.comments).toHaveLength(1);
      expect(repliesResult.current.data?.comments[0].uuid).toBe(reply!.uuid);
    });

    it('useComments projects nested replies as children of top-level page comments', async () => {
      const workspaceId = uuidv7();
      const { store, Wrapper } = await setupStore(workspaceId);

      const pageId = uuidv7();
      const parentCommentId = createCommentNode(store, pageId, 'Parent comment');
      const replyId = createCommentNode(store, parentCommentId, 'Nested reply');

      const { result: commentsResult } = renderHook(() => useComments(pageId), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(commentsResult.current.isLoading).toBe(false));

      const topLevel = commentsResult.current.data?.comments ?? [];
      expect(topLevel).toHaveLength(1);
      expect(topLevel[0].uuid).toBe(parentCommentId);
      expect(topLevel[0].children).toHaveLength(1);
      expect(topLevel[0].children![0].uuid).toBe(replyId);
      expect(topLevel[0].children![0].parent_uuid).toBe(parentCommentId);
    });

    it('useComments returns only active comment blocks and excludes deleted/non-comment children', async () => {
      const workspaceId = uuidv7();
      const { store, Wrapper } = await setupStore(workspaceId);

      const pageId = uuidv7();
      act(() => {
        store.createNode({ nodeId: pageId, kind: 'page', parentId: null });
      });

      const activeCommentId = createCommentNode(store, pageId, 'Active comment');

      const plainBlockId = uuidv7();
      act(() => {
        store.createNode({ nodeId: plainBlockId, kind: 'block', parentId: pageId });
        store.moveNode(plainBlockId, pageId);
      });

      const deletedCommentId = createCommentNode(store, pageId, 'Deleted comment');
      act(() => {
        store.deleteNode(deletedCommentId);
      });

      const { result: commentsResult } = renderHook(() => useComments(pageId), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(commentsResult.current.isLoading).toBe(false));

      const comments = commentsResult.current.data?.comments ?? [];
      expect(comments).toHaveLength(1);
      expect(comments[0].uuid).toBe(activeCommentId);
      expect(comments.some((c) => c.uuid === plainBlockId)).toBe(false);
      expect(comments.some((c) => c.uuid === deletedCommentId)).toBe(false);
    });
  });
});
