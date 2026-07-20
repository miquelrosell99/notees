/**
 * useNodesWithProperty
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { propertyKeys } from '@/hooks/queryKeys';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryAll } from '@/core/db/sqlite';

function parseClassName(contentJson: string): string {
  try {
    const content = JSON.parse(contentJson) as unknown[];
    return content.map((c) => (c as { text?: string }).text ?? '').join('').trim();
  } catch {
    return '';
  }
}

export function useNodesWithProperty(propertyUuid: string | null) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: _error } = useWorkspaceStore(workspaceId ?? '');

  return useQuery({
    queryKey: propertyKeys.nodes(propertyUuid ?? ''),
    queryFn: () => {
      if (!store || !propertyUuid) return [];
      const db = store.getDb();
      const rows = queryAll<{
        node_id: string;
        value: string;
        kind: string;
        parent_id: string | null;
        class_ids: string;
        content: string;
        created_at: string | null;
        updated_at: string | null;
      }>(
        db,
        `SELECT
           n.id AS node_id,
           v.value,
           n.kind,
           n.parent_id,
           n.class_ids,
           n.content,
           n.created_at,
           n.updated_at
         FROM property_value v
         JOIN node n ON n.id = v.node_id
         WHERE v.property_schema_id = ? AND n.active = 1`,
        [propertyUuid]
      );

      return rows.map((row) => {
        const name = parseClassName(row.content);
        const classIds = (() => {
          try {
            return JSON.parse(row.class_ids) as string[];
          } catch {
            return [];
          }
        })();
        const isClass = classIds.includes('class') || row.kind === 'class';
        const pageUuid = row.parent_id ?? row.node_id;
        return {
          uuid: row.node_id,
          name,
          icon: null,
          color: null,
          parent_uuid: row.parent_id,
          page_uuid: pageUuid,
          is_page: row.kind === 'page' || row.parent_id === null,
          is_class: isClass,
          sequence: 0,
          active: true,
          create_date: row.created_at ?? new Date().toISOString(),
          write_date: row.updated_at ?? new Date().toISOString(),
          classes_uuid: classIds,
        } as unknown as Node;
      });
    },
    enabled: !!propertyUuid && !storeLoading && !!store,
    staleTime: 30000,
  });
}
