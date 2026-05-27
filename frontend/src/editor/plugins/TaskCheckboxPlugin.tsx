/**
 * TaskCheckboxPlugin — Click handler for task checkboxes in the editor.
 *
 * When a user clicks the checkbox in a task block's bullet area,
 * toggle the task status between "Pending" and "Done".
 * If the block doesn't have the task class yet, add it first.
 */

import { useEffect, useMemo } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useQueryClient } from '@tanstack/react-query';
import {
  useClasses,
  useProperties,
  useAddClass,
  useSetNodeProperty,
} from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { BatchPropertiesResult } from '@/api/nodes';

export function TaskCheckboxPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const queryClient = useQueryClient();
  const { data: allClasses } = useClasses();
  const { data: allProperties } = useProperties();
  const addClass = useAddClass();
  const setNodeProperty = useSetNodeProperty();

  const taskClass = allClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.task);
  const taskClassId = taskClass?.id ?? null;

  const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
  const statusPropId = statusProp?.id ?? null;

  const statusNameToId = useMemo(() => {
    const map = new Map<string, number>();
    if (statusProp?.options) {
      for (const opt of statusProp.options) {
        map.set(opt.name, opt.id);
      }
    }
    return map;
  }, [statusProp]);

  useEffect(() => {
    if (taskClassId == null) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('bullet-checkbox')) return;

      const blockId = target.dataset.blockId;
      if (!blockId) return;

      e.preventDefault();
      e.stopPropagation();

      // Use runtime for reliable class/property lookup
      const runtime = getNodeGraphRuntime();
      const graphNode = runtime.getNode(blockId);
      if (!graphNode?.serverId) return;

      const serverId = graphNode.serverId;
      const classIds = graphNode.classIds.map(String);
      const hasTask = classIds.includes(String(taskClassId));

      if (!hasTask) {
        addClass.mutate({ nodeId: serverId, classId: taskClassId });
        return;
      }

      // Read current status from batch-properties cache
      let currentSelId: unknown = undefined;
      const allQueries = queryClient.getQueriesData<BatchPropertiesResult>({
        queryKey: [...nodeKeys.all, 'batch-properties'],
      });
      for (const [, data] of allQueries) {
        if (data?.[String(serverId)]?.[String(statusPropId)] !== undefined) {
          currentSelId = data[String(serverId)][String(statusPropId)];
          break;
        }
      }

      const currentName = typeof currentSelId === 'number'
        ? (() => {
            for (const [name, id] of statusNameToId) {
              if (id === currentSelId) return name;
            }
            return null;
          })()
        : null;

      const nextName = currentName === 'Done' ? 'Pending' : 'Done';
      const nextId = statusNameToId.get(nextName);
      if (nextId != null && statusPropId != null) {
        setNodeProperty.mutate({ nodeId: serverId, propertyId: statusPropId, value: nextId });
      }
    };

    rootEl.addEventListener('click', handleClick);
    return () => rootEl.removeEventListener('click', handleClick);
  }, [editor, taskClassId, statusPropId, statusNameToId, addClass, setNodeProperty, queryClient]);

  return null;
}
