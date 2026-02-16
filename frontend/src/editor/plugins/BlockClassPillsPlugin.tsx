/**
 * BlockClassPillsPlugin — Renders class pills on each block in the Lexical editor.
 *
 * Reads classIds from each BlockNode and renders NodePill components
 * (the same component used by the page header class section) into the
 * `.node-block-class-pills` container via React portals.
 * This makes class pills visible in list and document view modes.
 */

import { useEffect, useState, useCallback, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { NodePill } from '@/components/nodes/NodePill';
import type { Node } from '@/types';
import { useClasses, useRemoveClass } from '@/hooks';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';

// ─── Types ────────────────────────────────────────────────────────

interface BlockClassInfo {
  blockId: string;
  classIds: string[];
  container: HTMLElement;
}

// ─── Plugin ─────────────────────────────────────────────────────

export interface BlockClassPillsPluginProps {
  onNavigateToNode?: (linkId: string) => void;
}

export function BlockClassPillsPlugin({
  onNavigateToNode,
}: BlockClassPillsPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const { data: allClasses } = useClasses();
  const removeClass = useRemoveClass();
  const [blockClasses, setBlockClasses] = useState<BlockClassInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Build a lookup map from class UUID to Node object
  const classMap = new Map<string, Node>();
  if (allClasses) {
    for (const cls of allClasses) {
      classMap.set(String(cls.id), cls);
    }
  }

  // Scan all BlockNodes and extract class info + DOM containers
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: BlockClassInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;
        const classIds = child.getClassIds();
        if (classIds.length === 0) continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const container = blockEl.querySelector('.node-block-class-pills') as HTMLElement;
        if (!container) continue;

        infos.push({ blockId, classIds, container });
      }

      setBlockClasses(infos);
    });
  }, [editor, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state changes (class additions, block changes)
  useEffect(() => {
    // Initial scan
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      // Only re-scan when blocks are structurally dirty (classIds sync)
      // or during runtime-sync (which updates classIds on existing blocks)
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      // Defer to next microtask so DOM is up-to-date
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Render portals
  if (!allClasses || blockClasses.length === 0) return null;

  return (
    <>
      {blockClasses.map(({ blockId, classIds, container }) => {
        // Resolve class IDs to Node objects, filtering out the implicit "page" class
        const resolvedClasses = classIds
          .map(id => classMap.get(id))
          .filter((cls): cls is Node =>
            cls !== undefined && cls.uuid !== SYSTEM_CLASS_UUIDS.page
          );

        if (resolvedClasses.length === 0) return null;

        return createPortal(
          <span key={blockId} className="node-block-class-pills-inner">
            {resolvedClasses.map(cls => (
              <NodePill
                key={cls.id}
                node={cls}
                className="node-block-class-pill"
                onClick={() => onNavigateToNode?.(cls.uuid)}
                onRemove={() => {
                  const runtime = getNodeGraphRuntime();
                  const graphNode = runtime.getNode(blockId);
                  if (graphNode?.serverId) {
                    removeClass.mutate({ nodeId: graphNode.serverId, classId: cls.id });
                  }
                }}
              />
            ))}
          </span>,
          container,
        );
      })}
    </>
  );
}
