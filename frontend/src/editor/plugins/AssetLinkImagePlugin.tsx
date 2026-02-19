/**
 * AssetLinkImagePlugin — Renders inline asset previews for blocks that link to asset nodes.
 *
 * When a block contains a [[nodeUuid]] link to a node that has the 'asset' class,
 * this plugin renders the corresponding ImageNode below that block's content,
 * as if the block itself were an asset block.
 *
 * Uses the portal pattern: dynamically creates a container div on the block DOM
 * and portals the ImageNode into it.
 */

import { useEffect, useState, useCallback, useMemo, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { $isInlineLinkNode } from '../nodes/InlineLinkNode';
import { ImageNode } from '@/components/nodes/ImageNode';
import { useNodes, useClasses } from '@/hooks';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { parseLinkId } from '@/lib/astBuilder';
import { useVirtualization } from './VirtualizationPlugin';

// ─── Types ────────────────────────────────────────────────────────

interface AssetLinkInfo {
  /** Block that contains the link */
  blockId: string;
  /** Server ID of the linked asset node (for ImageNode) */
  assetServerId: number;
  /** Portal container element */
  container: HTMLElement;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Recursively collect all InlineLinkNode linkIds from a Lexical node tree. */
function collectPillLinkIds(node: import('lexical').LexicalNode): string[] {
  const ids: string[] = [];
  if ($isInlineLinkNode(node)) {
    if (node.getRefType() === 'node') {
      ids.push(node.getLinkId());
    }
    return ids;
  }
  if ('getChildren' in node && typeof (node as { getChildren: () => import('lexical').LexicalNode[] }).getChildren === 'function') {
    for (const child of (node as { getChildren: () => import('lexical').LexicalNode[] }).getChildren()) {
      ids.push(...collectPillLinkIds(child));
    }
  }
  return ids;
}

// Container class name for cleanup
const CONTAINER_CLASS = 'node-block-linked-asset-preview';

// ─── Plugin ─────────────────────────────────────────────────────

export function AssetLinkImagePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [assetLinks, setAssetLinks] = useState<AssetLinkInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Get all nodes to build UUID→node map for asset class checking
  const { data: allNodes } = useNodes();
  const { data: allClasses } = useClasses();

  // Resolve asset class server ID
  const assetClassId = useMemo(() => {
    if (!allClasses) return null;
    const cls = allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.asset);
    return cls?.id ?? null;
  }, [allClasses]);

  // Build UUID → { serverId, isAsset } map
  const nodeUuidMap = useMemo(() => {
    if (!allNodes || assetClassId == null) return null;
    const map = new Map<string, { serverId: number; isAsset: boolean }>();
    for (const node of allNodes) {
      if (!node.uuid) continue;
      const isAsset = node.classes?.includes(assetClassId) ?? false;
      map.set(node.uuid, { serverId: node.id, isAsset });
    }
    return map;
  }, [allNodes, assetClassId]);

  // Scan BlockNodes for InlineLinkNodes linking to asset nodes
  const scanBlocks = useCallback(() => {
    if (!nodeUuidMap) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: AssetLinkInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;

        // Skip asset blocks themselves (they already have AssetBlockPlugin handling them)
        if (child.getNodeType() === 'asset') continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        // Collect all pill link IDs from this block
        const linkIds = collectPillLinkIds(child);
        if (linkIds.length === 0) continue;

        // Check each link to see if it references an asset node
        for (const linkId of linkIds) {
          try {
            const { nodeUuid } = parseLinkId(linkId);
            const nodeInfo = nodeUuidMap.get(nodeUuid);
            if (nodeInfo?.isAsset) {
              const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
              if (!blockEl) continue;

              // Find or create the container for linked asset previews
              let container = blockEl.querySelector(`.${CONTAINER_CLASS}`) as HTMLElement;
              if (!container) {
                container = document.createElement('div');
                container.className = CONTAINER_CLASS;
                container.contentEditable = 'false';
                blockEl.appendChild(container);
              }

              infos.push({
                blockId,
                assetServerId: nodeInfo.serverId,
                container,
              });
            }
          } catch {
            // Invalid link ID format, skip
          }
        }
      }

      setAssetLinks(infos);
    });
  }, [editor, nodeUuidMap, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state or node data changes
  useEffect(() => {
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Clean up containers when unmounting or when blocks no longer have asset links
  useEffect(() => {
    return () => {
      const rootEl = editor.getRootElement();
      if (!rootEl) return;
      rootEl.querySelectorAll(`.${CONTAINER_CLASS}`).forEach(el => el.remove());
    };
  }, [editor]);

  // Render portals
  if (assetLinks.length === 0) return null;

  return (
    <>
      {assetLinks.map(({ blockId, assetServerId, container }) =>
        createPortal(
          <ImageNode
            key={`${blockId}-${assetServerId}`}
            assetNodeId={assetServerId}
            showCard={false}
            elevation="none"
            radius="sm"
            clickable={true}
            showActions={false}
            className="node-block-linked-asset-image"
          />,
          container,
        )
      )}
    </>
  );
}
