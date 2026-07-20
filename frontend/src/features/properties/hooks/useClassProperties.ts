/**
 * Class Properties Hooks
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ClassProperty, ClassExtends, InheritedProperty, ExtendedByClass, Node } from '@/types/api';
import {
  useClassPropertiesAdapter,
  useNodeClassPropertyEdgesAdapter,
} from '@/core/adapters/useClassPropertiesAdapter';
import { useWorkspaceStore, useClasses } from '@/core/hooks';
import { queryAll } from '@/core/db/sqlite';

function useClassRows(): Node[] {
  const { data: classes } = useClasses();
  return classes ?? [];
}

function classNameByUuid(classes: Node[], uuid: string): string {
  return classes.find((c) => c.uuid === uuid)?.name ?? uuid;
}

function toQueryResult<TData>(
  data: TData | undefined,
  isLoading: boolean,
  error: Error | null
): UseQueryResult<TData, Error> {
  return {
    data,
    isLoading,
    isError: error !== null,
    error,
    isPending: isLoading,
    isSuccess: !isLoading && error === null,
    status: isLoading ? 'pending' : error ? 'error' : 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<TData, Error>;
}

export function useClassProperties(classId: string | null, includeInherited: boolean = false) {
  return useClassPropertiesAdapter(classId, includeInherited);
}

export function useNodeClassPropertyEdges(classUuids: string[]): ClassProperty[] {
  return useNodeClassPropertyEdgesAdapter(classUuids);
}

export function useClassExtends(classId: string | null): UseQueryResult<ClassExtends[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const classes = useClassRows();
  const [data, setData] = useState<ClassExtends[] | undefined>(undefined);

  useEffect(() => {
    if (!store || !classId) {
      setData(undefined);
      return;
    }
    const update = (): void => {
      const rows = queryAll<{ ancestor_id: string }>(
        store.getDb(),
        'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ? ORDER BY ancestor_id',
        [classId, classId]
      );
      setData(
        rows.map((row, index) => ({
          class_node_uuid: classId,
          class_node_name: classNameByUuid(classes, classId),
          extends_class_node_uuid: row.ancestor_id,
          extends_class_node_name: classNameByUuid(classes, row.ancestor_id),
          sequence: index,
        }))
      );
    };
    update();
    return store.subscribeAll(update);
  }, [store, classId, classes]);

  return toQueryResult(data, isLoading, error);
}

export function useInheritedProperties(classId: string | null): UseQueryResult<InheritedProperty[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const classes = useClassRows();
  const [data, setData] = useState<InheritedProperty[] | undefined>(undefined);

  useEffect(() => {
    if (!store || !classId) {
      setData(undefined);
      return;
    }
    const db = store.getDb();
    const update = (): void => {
      const directIds = new Set(
        queryAll<{ property_schema_id: string }>(
          db,
          'SELECT property_schema_id FROM class_property_edge WHERE class_id = ?',
          [classId]
        ).map((r) => r.property_schema_id)
      );
      const rows = queryAll<{
        ancestor_id: string;
        property_schema_id: string;
        property_name: string;
        property_type: string;
        sequence: number;
        default_value: string | null;
        hidden: number;
      }>(
        db,
        `SELECT
           h.ancestor_id,
           e.property_schema_id,
           s.name AS property_name,
           s.type AS property_type,
           e.sequence,
           e.default_value,
           e.hidden
         FROM class_hierarchy h
         JOIN class_property_edge e ON e.class_id = h.ancestor_id
         JOIN property_schema s ON s.id = e.property_schema_id
         WHERE h.class_id = ? AND h.ancestor_id != ? AND s.active = 1
         ORDER BY e.sequence`,
        [classId, classId]
      );

      const seen = new Set<string>();
      setData(
        rows
          .filter((row) => !directIds.has(row.property_schema_id))
          .filter((row) => {
            if (seen.has(row.property_schema_id)) return false;
            seen.add(row.property_schema_id);
            return true;
          })
          .map((row) => ({
            property_uuid: row.property_schema_id,
            property_name: row.property_name,
            property_type: row.property_type as InheritedProperty['property_type'],
            from_class_uuid: row.ancestor_id,
            from_class_name: classNameByUuid(classes, row.ancestor_id),
            sequence: row.sequence,
            default_value: (() => {
              try {
                return JSON.parse(row.default_value ?? 'null') as unknown;
              } catch {
                return null;
              }
            })(),
            hidden: row.hidden !== 0,
            is_overridden: false,
          }))
      );
    };
    update();
    return store.subscribeAll(update);
  }, [store, classId, classes]);

  return toQueryResult(data, isLoading, error);
}

export function useExtendedByClasses(classId: string | null): UseQueryResult<ExtendedByClass[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const classes = useClassRows();
  const [data, setData] = useState<ExtendedByClass[] | undefined>(undefined);

  useEffect(() => {
    if (!store || !classId) {
      setData(undefined);
      return;
    }
    const update = (): void => {
      const rows = queryAll<{ class_id: string }>(
        store.getDb(),
        'SELECT class_id FROM class_hierarchy WHERE ancestor_id = ? AND class_id != ?',
        [classId, classId]
      );
      setData(
        rows.map((row) => ({
          nodeUuid: row.class_id,
          uuid: row.class_id,
          name: classNameByUuid(classes, row.class_id),
          icon: classes.find((c) => c.uuid === row.class_id)?.icon ?? null,
        }))
      );
    };
    update();
    return store.subscribeAll(update);
  }, [store, classId, classes]);

  return toQueryResult(data, isLoading, error);
}

export function useValidateClassExtends() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');

  return {
    mutate: ({
      classId,
      extendsIds,
    }: {
      classId: string;
      extendsIds: string[];
    }): { valid: boolean; error?: string; cycle_path?: string[] } => {
      if (!store) {
        return { valid: true };
      }

      for (const candidateId of extendsIds) {
        if (candidateId === classId) {
          return { valid: false, error: 'Circular inheritance', cycle_path: [classId, candidateId] };
        }
        const visited: string[] = [];
        const stack = [candidateId];
        while (stack.length > 0) {
          const current = stack.pop()!;
          if (current === classId) {
            return { valid: false, error: 'Circular inheritance', cycle_path: [...visited, classId] };
          }
          if (visited.includes(current)) continue;
          visited.push(current);
          const parents = queryAll<{ ancestor_id: string }>(
            store.getDb(),
            'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ?',
            [current, current]
          );
          for (const parent of parents) {
            stack.push(parent.ancestor_id);
          }
        }
      }

      return { valid: true };
    },
  };
}
