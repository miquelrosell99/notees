import { useCallback, useState } from 'react';
import { useCreateNode, useSystemClasses } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useNotificationStore } from '@/stores/notificationStore';
import type { QueryAST } from '@/types/queryAST';

/**
 * Promote a query AST to a stored view: a new page (title = view name) with
 * one query-class child block whose name carries the query — the same shape
 * `useQueryBlock.saveQueryAST` writes, so the page renders the live query
 * with no special-case rendering. Navigates to the page on success.
 */
export function useSaveQueryAsView() {
  const createNode = useCreateNode();
  const { systemClassUuids } = useSystemClasses();
  const openNode = useNavigationStore((s) => s.openNode);
  const closeNodeCollection = useNavigationStore((s) => s.closeNodeCollection);
  const [isSaving, setIsSaving] = useState(false);

  const saveAsView = useCallback(
    async (title: string, ast: QueryAST) => {
      const trimmed = title.trim();
      if (!trimmed || isSaving) return;
      if (!systemClassUuids?.query) {
        useNotificationStore
          .getState()
          .error('Setup incomplete', 'Query class not found. Please reload the app.');
        return;
      }
      setIsSaving(true);
      try {
        const page = await createNode.mutateAsync({
          name: trimmed,
          kind: 'page',
        });
        const nameAST = [
          { type: 'paragraph' as const, children: [{ type: 'text' as const, text: trimmed }] },
          { type: 'query' as const, data: ast },
        ];
        await createNode.mutateAsync({
          name: JSON.stringify(nameAST),
          parent_uuid: page.uuid,
          class_uuids: [systemClassUuids.query],
        });
        closeNodeCollection();
        openNode(page.uuid);
      } catch (err) {
        useNotificationStore
          .getState()
          .error('Failed to save view', err instanceof Error ? err.message : undefined);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [createNode, systemClassUuids, openNode, closeNodeCollection, isSaving],
  );

  return { saveAsView, isSaving };
}
