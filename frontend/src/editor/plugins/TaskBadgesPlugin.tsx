/**
 * TaskBadgesPlugin — Renders inline task badges on task-class blocks.
 *
 * Shows:
 * - Overdue deadline → red "Overdue" badge
 * - Today's deadline → orange "Today" badge
 * - Priority → colored dot (High=red, Medium=yellow, Low=green)
 *
 * Reads batch properties for deadline and priority values.
 */

import { useEffect, useState, useCallback, useMemo, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useQueryClient } from '@tanstack/react-query';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import { useClasses, useBatchPropertyValues } from '@/hooks';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';

interface BlockDOMInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;
}

interface BadgeInfo {
  type: 'overdue' | 'today' | 'priority';
  label: string;
  priorityLevel?: 'high' | 'medium' | 'low';
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function parseDeadline(value: unknown): Date | null {
  if (value == null) return null;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return null;
  return d;
}

export function TaskBadgesPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const { data: allClasses } = useClasses();
  const [blockDOMs, setBlockDOMs] = useState<BlockDOMInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  const taskClass = allClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.task);
  const taskClassId = taskClass?.id ?? null;

  const scanBlocks = useCallback(() => {
    if (!taskClassId) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: BlockDOMInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;

        const blockId = child.getBlockId();

        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        // Only show badges for task-class blocks
        const classIds = child.getClassIds();
        if (!classIds.includes(String(taskClassId))) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const container = blockEl.querySelector('.node-block-task-badges') as HTMLElement;
        if (!container) continue;

        infos.push({ blockId, serverId: graphNode.serverId, container });
      }

      setBlockDOMs(infos);
    });
  }, [editor, taskClassId, virtualizationEnabled, visibleBlockIds]);

  useEffect(() => {
    if (!taskClassId) return;
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      queueMicrotask(scanBlocks);
    });
  }, [editor, scanBlocks, taskClassId, visibleBlockIds]);

  const serverIds = useMemo(() => blockDOMs.map(b => b.serverId), [blockDOMs]);
  const { data: batchProps } = useBatchPropertyValues(serverIds);

  // Resolve property IDs from the batch property data keys if available,
  // otherwise we can't map. We need the property definitions.
  // Since useBatchPropertyValues doesn't give us property metadata,
  // we need to use useProperties or queryClient to get property definitions.
  const queryClient = useQueryClient();
  const propertyList = queryClient.getQueryData<{ id: number; uuid: string; options?: { id: number; name: string }[] }[]>(['properties', 'list']);

  const deadlinePropId = useMemo(() => {
    return propertyList?.find((p: { uuid: string }) => p.uuid === SYSTEM_PROPERTY_UUIDS.task_deadline)?.id ?? null;
  }, [propertyList]);

  const priorityPropId = useMemo(() => {
    return propertyList?.find((p: { uuid: string }) => p.uuid === SYSTEM_PROPERTY_UUIDS.task_priority)?.id ?? null;
  }, [propertyList]);

  const badgesIndex = useMemo(() => {
    const index = new Map<string, BadgeInfo[]>();
    if (!batchProps) return index;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const info of blockDOMs) {
      const nodeProps = batchProps[String(info.serverId)];
      if (!nodeProps) continue;

      const badges: BadgeInfo[] = [];

      if (deadlinePropId != null) {
        const deadlineVal = nodeProps[String(deadlinePropId)];
        const deadline = parseDeadline(deadlineVal);
        if (deadline) {
          const deadlineDay = new Date(deadline);
          deadlineDay.setHours(0, 0, 0, 0);
          if (deadlineDay < today) {
            badges.push({ type: 'overdue', label: 'Overdue' });
          } else if (isSameDay(deadlineDay, today)) {
            badges.push({ type: 'today', label: 'Today' });
          }
        }
      }

      if (priorityPropId != null) {
        const priorityVal = nodeProps[String(priorityPropId)];
        if (typeof priorityVal === 'number') {
          const priorityProp = propertyList?.find((p: { id: number }) => p.id === priorityPropId);
          const option = priorityProp?.options?.find((o: { id: number }) => o.id === priorityVal);
          const name = option?.name ?? '';
          let level: 'high' | 'medium' | 'low' | undefined;
          if (name === 'High') level = 'high';
          else if (name === 'Medium') level = 'medium';
          else if (name === 'Low') level = 'low';
          if (level) {
            badges.push({ type: 'priority', label: name, priorityLevel: level });
          }
        }
      }

      if (badges.length > 0) {
        index.set(info.blockId, badges);
      }
    }

    return index;
  }, [batchProps, blockDOMs, deadlinePropId, priorityPropId, propertyList]);

  if (!taskClassId || badgesIndex.size === 0) return null;

  return (
    <>
      {blockDOMs.map(info => {
        const badges = badgesIndex.get(info.blockId);
        if (!badges) return null;

        return createPortal(
          <>
            {badges.map((badge, i) => {
              if (badge.type === 'priority') {
                return (
                  <span key={i} className="task-badge task-badge--priority" title={`Priority: ${badge.label}`}>
                    <span className={`task-badge__dot task-badge__dot--${badge.priorityLevel}`} />
                    <span>{badge.label}</span>
                  </span>
                );
              }
              return (
                <span key={i} className={`task-badge task-badge--${badge.type}`}>
                  {badge.label}
                </span>
              );
            })}
          </>,
          info.container,
        );
      })}
    </>
  );
}
