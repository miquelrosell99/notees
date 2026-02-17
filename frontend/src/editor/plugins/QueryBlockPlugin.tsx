/**
 * QueryBlockPlugin — Renders query results on query blocks via portals.
 *
 * For blocks with nodeType === 'query', renders the QueryNodeCollection
 * component into the `.node-block-query-preview` portal container.
 *
 * Follows the same portal pattern as AssetBlockPlugin and TableBlockPlugin.
 */

import { useEffect, useState, useCallback, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { QueryNodeCollection } from '@/components/nodes/QueryNodeCollection';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import { useAppStore } from '@/stores';

// ─── Types ────────────────────────────────────────────────────────

interface QueryBlockInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;
}

// ─── Inner Component (per query block) ────────────────────────────

interface QueryPreviewProps {
  blockId: string;
  serverId: number;
}

/**
 * Renders a single query block's results using QueryNodeCollection.
 */
function QueryPreview({ blockId, serverId }: QueryPreviewProps): JSX.Element {
  const openNode = useAppStore(state => state.openNode);
  const openNodeInSidebar = useAppStore(state => state.openNodeInSidebar);

  return (
    <QueryNodeCollection
      nodeId={serverId}
      nodeUuid={blockId}
      viewType="main_content"
      onNodeClick={(nodeId, isPage) => {
        if (isPage) {
          openNode(nodeId);
        } else {
          openNodeInSidebar(nodeId, 'block');
        }
      }}
      hideToolbar={false}
      hideViewManagement={false}
      showAddButton={false}
    >
      {({ results, count, isLoading }) => {
        if (!isLoading && count === 0) return null;
        return <div className="query-block-results">{results}</div>;
      }}
    </QueryNodeCollection>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────

export function QueryBlockPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [queryBlocks, setQueryBlocks] = useState<QueryBlockInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Scan all BlockNodes and extract query blocks with DOM containers
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: QueryBlockInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;
        if (child.getNodeType() !== 'query') continue;

        const blockId = child.getBlockId();

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const container = blockEl.querySelector('.node-block-query-preview') as HTMLElement;
        if (!container) continue;

        // Resolve serverId from runtime
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        infos.push({ blockId, serverId: graphNode.serverId, container });
      }

      setQueryBlocks(infos);
    });
  }, [editor, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state changes
  useEffect(() => {
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Render portals
  if (queryBlocks.length === 0) return null;

  return (
    <>
      {queryBlocks.map(({ blockId, serverId, container }) =>
        createPortal(
          <QueryPreview
            key={blockId}
            blockId={blockId}
            serverId={serverId}
          />,
          container,
        ),
      )}
    </>
  );
}
