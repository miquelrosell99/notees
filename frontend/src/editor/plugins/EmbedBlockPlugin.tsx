/**
 * EmbedBlockPlugin — Renders embedded node cards via React portals.
 *
 * Scans all BlockNodes in the Lexical tree for blocks whose contentAST
 * contains a node_link with ref_type === 'embed'. For each such block,
 * a React portal is mounted in a `.node-block-embed-preview` container
 * below the block content, rendering the full EmbedBlock card.
 *
 * Follows the same portal pattern as AssetBlockPlugin and QueryBlockPlugin.
 */

import { useEffect, useState, useCallback, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { $isInlineLinkNode } from '../nodes/InlineLinkNode';
import { EmbedBlock } from '../../components/blocks/EmbedBlock';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';

// ─── Types ────────────────────────────────────────────────────────

interface EmbedBlockInfo {
  /** The host block's UUID (blockId in runtime) */
  hostBlockId: string;
  /** The UUID of the embedded node (= link_id from the embed pill) */
  embeddedNodeUuid: string;
  /** DOM container to portal into */
  container: HTMLElement;
}

// ─── Plugin ─────────────────────────────────────────────────────

export function EmbedBlockPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [embedBlocks, setEmbedBlocks] = useState<EmbedBlockInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Scan all BlockNodes and detect those with embed pills
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: EmbedBlockInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        // Check if this block has an embed pill in its Lexical children
        let embedLinkId: string | null = null;
        for (const inline of child.getChildren()) {
          if ($isInlineLinkNode(inline) && inline.getRefType() === 'embed') {
            embedLinkId = inline.getLinkId();
            break;
          }
        }

        if (!embedLinkId) {
          // Also check the runtime contentAST for blocks that haven't
          // been fully hydrated (Phase-1 populateBlockContentLight placeholders)
          const graphNode = runtime.getNode(blockId);
          if (graphNode) {
            for (const para of graphNode.contentAST) {
              if (!para.children) continue; // whiteboard/query blocks have no inline children
              for (const inline of para.children) {
                if (inline.type === 'node_link' && inline.ref_type === 'embed') {
                  embedLinkId = inline.link_id;
                  break;
                }
              }
              if (embedLinkId) break;
            }
          }
        }

        if (!embedLinkId) continue;

        // Get or create the `.node-block-embed-preview` container
        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement | null;
        if (!blockEl) continue;

        let container = blockEl.querySelector('.node-block-embed-preview') as HTMLElement | null;
        if (!container) {
          container = document.createElement('div');
          container.className = 'node-block-embed-preview';
          container.contentEditable = 'false';
          blockEl.appendChild(container);
        }

        infos.push({
          hostBlockId: blockId,
          embeddedNodeUuid: embedLinkId,
          container,
        });
      }

      // Remove embed containers from blocks that no longer have embed pills
      const activeBlockIds = new Set(infos.map(i => i.hostBlockId));
      rootEl.querySelectorAll('.node-block-embed-preview').forEach(el => {
        const blockEl = el.closest('[data-block-id]') as HTMLElement | null;
        const bid = blockEl?.dataset.blockId;
        if (bid && !activeBlockIds.has(bid)) {
          el.remove();
        }
      });

      setEmbedBlocks(infos);
    });
  }, [editor, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state changes
  useEffect(() => {
    // Initial scan
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      // Defer to next microtask so DOM is up-to-date
      setTimeout(scanBlocks, 0);
    });
  }, [editor, scanBlocks]);

  if (embedBlocks.length === 0) return null;

  return (
    <>
      {embedBlocks.map(({ hostBlockId, embeddedNodeUuid, container }) =>
        createPortal(
          <EmbedBlock
            key={`${hostBlockId}-${embeddedNodeUuid}`}
            embeddedNodeUuid={embeddedNodeUuid}
            hostBlockId={hostBlockId}
          />,
          container,
        )
      )}
    </>
  );
}
