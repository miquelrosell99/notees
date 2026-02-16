/**
 * AssetBlockPlugin — Renders asset previews (images, audio, files) on asset blocks.
 *
 * Scans all BlockNodes with nodeType === 'asset' and renders the appropriate
 * preview component (ImageNode for images) into the `.node-block-asset-preview`
 * container via React portals.
 *
 * Follows the same portal pattern as BlockClassPillsPlugin and
 * BlockPropertyIconsPlugin.
 */

import { useEffect, useState, useCallback, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { ImageNode } from '@/components/nodes/ImageNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';

// ─── Types ────────────────────────────────────────────────────────

interface AssetBlockInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;
}

// ─── Plugin ─────────────────────────────────────────────────────

export function AssetBlockPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [assetBlocks, setAssetBlocks] = useState<AssetBlockInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Scan all BlockNodes and extract asset blocks with DOM containers
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: AssetBlockInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;
        if (child.getNodeType() !== 'asset') continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const container = blockEl.querySelector('.node-block-asset-preview') as HTMLElement;
        if (!container) continue;

        // Resolve serverId from runtime
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        infos.push({ blockId, serverId: graphNode.serverId, container });
      }

      setAssetBlocks(infos);
    });
  }, [editor, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state changes
  useEffect(() => {
    // Initial scan
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      // Defer to next microtask so DOM is up-to-date
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Render portals
  if (assetBlocks.length === 0) return null;

  return (
    <>
      {assetBlocks.map(({ blockId, serverId, container }) =>
        createPortal(
          <ImageNode
            key={blockId}
            assetNodeId={serverId}
            showCard={false}
            elevation="none"
            radius="sm"
            clickable={true}
            showActions={false}
            className="node-block-asset-image"
          />,
          container,
        ),
      )}
    </>
  );
}
