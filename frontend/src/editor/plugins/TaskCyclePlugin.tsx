/**
 * TaskCyclePlugin — Ctrl+Enter cycles task status on the focused block.
 *
 * Cycle: (no task class) → add task (Pending) → Doing → Done → remove task class.
 *
 * No per-block queries. Uses useClasses/useProperties for metadata (O(1)).
 * Reads current status from TanStack Query cache (zero extra fetches).
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import { useQueryClient } from '@tanstack/react-query';
import { $isBlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import {
  useClasses,
  useProperties,
  useAddClass,
  useRemoveClass,
  useSetNodeProperty,
} from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { useInputContext } from '@/stores/inputContext';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, TASK_STATUS_CYCLE } from '@/constants/systemProperties';
import type { BatchPropertiesResult } from '@/api/nodes';

export function TaskCyclePlugin(): null {
  const [editor] = useLexicalComposerContext();
  const queryClient = useQueryClient();
  const { data: allClasses } = useClasses();
  const { data: allProperties } = useProperties();
  const addClass = useAddClass();
  const removeClass = useRemoveClass();
  const setNodeProperty = useSetNodeProperty();

  // Resolve task class UUID → server ID
  const taskClass = allClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.task);
  const taskClassId = taskClass?.id ?? null;

  // Resolve task status property UUID → property definition
  const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
  const statusPropId = statusProp?.id ?? null;

  // Build option name ↔ id maps for cycle lookups
  const statusNameToId = new Map<string, number>();
  const statusIdToName = new Map<number, string>();
  if (statusProp?.options) {
    for (const opt of statusProp.options) {
      statusNameToId.set(opt.name, opt.id);
      statusIdToName.set(opt.id, opt.name);
    }
  }

  // ─── Stable refs for use inside command handler ───────────────
  const refs = useRef({
    addClass, removeClass, setNodeProperty,
    taskClassId, statusPropId,
    statusNameToId, statusIdToName,
    queryClient,
  });
  refs.current = {
    addClass, removeClass, setNodeProperty,
    taskClassId, statusPropId,
    statusNameToId, statusIdToName,
    queryClient,
  };

  // ─── Command handler ─────────────────────────────────────────
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return false;

        // Don't cycle task status when a popup, modal, or drag is active
        if (useInputContext.getState().isOverlayOpen) return false;

        const {
          taskClassId: _taskClassId,
          statusPropId: _statusPropId,
          statusNameToId: _nameToId,
          statusIdToName: _idToName,
          addClass: _addClass,
          removeClass: _removeClass,
          setNodeProperty: _setProperty,
          queryClient: _queryClient,
        } = refs.current;

        if (_taskClassId == null || _statusPropId == null) return false;

        // Find the active block via selection
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        let lexNode = selection.anchor.getNode();
        while (lexNode && !$isBlockNode(lexNode)) {
          lexNode = lexNode.getParent() as typeof lexNode;
        }
        if (!lexNode || !$isBlockNode(lexNode)) return false;

        const blockId = lexNode.getBlockId();
        const runtime = getNodeGraphRuntime();
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) return false;

        const serverId = graphNode.serverId;
        const classIds = lexNode.getClassIds();
        const hasTask = classIds.includes(String(_taskClassId));

        event.preventDefault();

        if (!hasTask) {
          // No task class → add it (backend auto-applies Pending default)
          _addClass.mutate({ nodeId: serverId, classId: _taskClassId });
          return true;
        }

        // Has task class → read current status from TanStack Query cache
        // Look through all batch-properties queries in the cache
        let currentSelId: unknown = undefined;
        const allQueries = _queryClient.getQueriesData<BatchPropertiesResult>({
          queryKey: [...nodeKeys.all, 'batch-properties'],
        });
        for (const [, data] of allQueries) {
          if (data?.[String(serverId)]?.[String(_statusPropId)] !== undefined) {
            currentSelId = data[String(serverId)][String(_statusPropId)];
            break;
          }
        }

        const currentName = typeof currentSelId === 'number'
          ? _idToName.get(currentSelId) ?? null
          : null;

        // Find position in cycle
        const cycleIndex = currentName != null
          ? TASK_STATUS_CYCLE.indexOf(currentName as typeof TASK_STATUS_CYCLE[number])
          : -1;

        if (cycleIndex === -1 || currentName == null) {
          // Not in cycle or no status → set to Pending
          const pendingId = _nameToId.get(TASK_STATUS_CYCLE[0]);
          if (pendingId != null) {
            _setProperty.mutate({ nodeId: serverId, propertyId: _statusPropId, value: pendingId });
          }
        } else if (cycleIndex < TASK_STATUS_CYCLE.length - 1) {
          // Move to next status in cycle
          const nextName = TASK_STATUS_CYCLE[cycleIndex + 1];
          const nextId = _nameToId.get(nextName);
          if (nextId != null) {
            _setProperty.mutate({ nodeId: serverId, propertyId: _statusPropId, value: nextId });
          }
        } else {
          // At Done (last in cycle) → remove task class
          _removeClass.mutate({ nodeId: serverId, classId: _taskClassId });
        }

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
