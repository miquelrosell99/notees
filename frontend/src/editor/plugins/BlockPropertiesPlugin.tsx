/**
 * BlockPropertiesPlugin — Renders inline property rows below each block.
 *
 * Architecture (mirrors BlockPropertyIconsPlugin):
 * 1. ONE pass over the Lexical tree → extract all block serverIds + DOM refs
 *    Also captures classIds from each BlockNode.
 * 2. ONE batch query → fetch property values for all visible blocks
 * 3. Build a Set<blockId> of blocks that should render properties:
 *    - blocks with at least one explicitly-set property value, OR
 *    - blocks with at least one class assigned (classes define properties)
 * 4. Render PropertiesSection via portals into each block's
 *    .node-block-properties-preview container.
 *    PropertiesSection returns null internally when there's nothing to show.
 */

import { useEffect, useState, useCallback, useMemo, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import { useBatchPropertyValues } from '@/hooks';
import { PropertiesSection } from '@/components/properties/PropertiesSection';
import { useAppStore } from '@/stores';

// ─── Types ────────────────────────────────────────────────────────

interface BlockDOMInfo {
  blockId: string;
  serverId: number;
  classIds: string[];
  isProjectionRoot: boolean;
  previewContainer: HTMLElement;
}

// ─── Inline properties component (rendered per block via portal) ──

function BlockInlineProperties({ nodeId, showAddProperty, isMainNode }: { nodeId: number; showAddProperty: boolean; isMainNode: boolean }) {
  const openNode = useAppStore(state => state.openNode);
  const addSidebarCard = useAppStore(state => state.addSidebarCard);

  return (
    <PropertiesSection
      nodeId={nodeId}
      variant="block"
      inline={!showAddProperty}
      readOnly={false}
      showHiddenSection={showAddProperty}
      showAddProperty={showAddProperty}
      isMainNode={isMainNode}
      onNavigateToNode={openNode}
      onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
    />
  );
}

// ─── Main Plugin ──────────────────────────────────────────────────

export function BlockPropertiesPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [blockDOMs, setBlockDOMs] = useState<BlockDOMInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // ── Step 1: ONE pass — scan blocks, extract serverIds + DOM refs ─
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: BlockDOMInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const previewContainer = blockEl.querySelector('.node-block-properties-preview') as HTMLElement;
        if (!previewContainer) continue;

        infos.push({
          blockId,
          serverId: graphNode.serverId,
          classIds: child.getClassIds(),
          isProjectionRoot: child.getIsProjectionRoot(),
          previewContainer,
        });
      }

      setBlockDOMs(infos);
    });
  }, [editor, virtualizationEnabled, visibleBlockIds]);

  // ── Step 2: Rescan on structural changes ──────────────────────
  useEffect(() => {
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // ── Step 3: ONE batch query for all block property values ─────
  const serverIds = useMemo(
    () => blockDOMs.map(b => b.serverId),
    [blockDOMs],
  );
  const { data: batchProps } = useBatchPropertyValues(serverIds);

  // ── Step 4: Determine which blocks should show properties ─────
  // A block should show properties if:
  //   a) it is the projection root (focused block — always show "Add property")
  //   b) it has at least one explicitly-set property value, OR
  //   c) it has at least one class (classes can define properties)
  const blocksWithProperties = useMemo(() => {
    const set = new Set<string>();

    for (const info of blockDOMs) {
      // Projection root always shows (has "Add property" button)
      if (info.isProjectionRoot) {
        set.add(info.blockId);
        continue;
      }

      // Has classes → may have class-defined properties
      if (info.classIds.length > 0) {
        set.add(info.blockId);
        continue;
      }

      // Has explicitly-set property values
      if (batchProps) {
        const nodeProps = batchProps[String(info.serverId)];
        if (nodeProps && Object.keys(nodeProps).length > 0) {
          set.add(info.blockId);
        }
      }
    }

    return set;
  }, [batchProps, blockDOMs]);

  // ── Step 5: Render portals for blocks with properties ─────────
  if (blocksWithProperties.size === 0) return null;

  return (
    <>
      {blockDOMs.map(info => {
        if (!blocksWithProperties.has(info.blockId)) return null;

        return (
          <span key={info.blockId}>
            {createPortal(
              <BlockInlineProperties nodeId={info.serverId} showAddProperty={info.isProjectionRoot} isMainNode={info.isProjectionRoot} />,
              info.previewContainer,
            )}
          </span>
        );
      })}
    </>
  );
}
