/**
 * QueryBlockPlugin — Renders query results on query blocks via portals.
 *
 * For blocks with nodeType === 'query', renders the QueryNodeCollection
 * component into the `.node-block-query-preview` portal container.
 *
 * Follows the same portal pattern as AssetBlockPlugin and TableBlockPlugin.
 */

import { useEffect, useState, useCallback, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { QueryNodeCollection } from '@/components/nodes/QueryNodeCollection';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import { useAppStore } from '@/stores';
import { useQueryBlock } from '@/hooks/useQueryBlock';

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
 * Reads the QueryAST from the node's `name` AST field (inline mode).
 *
 * Wraps everything in an event-isolating container so that mousedown events
 * don't bubble to Lexical's handlers (BlockDragSelectionPlugin, EmptyClickPlugin,
 * BlurOnClickOutsidePlugin) which would trigger editor state changes, re-scans,
 * and remount this component — losing modal state.
 */
function QueryPreview({ blockId, serverId }: QueryPreviewProps): JSX.Element {
  const openNode = useAppStore(state => state.openNode);
  const openNodeInSidebar = useAppStore(state => state.openNodeInSidebar);
  const { queryAST, saveQueryAST } = useQueryBlock(serverId);
  const isolatorRef = useRef<HTMLDivElement>(null);

  // Resolve node name from runtime for query context (e.g. {{current_node}} placeholders)
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(blockId);

  // Attach native mousedown/pointerdown listeners on the isolator div to prevent
  // the events from bubbling to Lexical's native handlers on rootEl.
  // BlockDragSelectionPlugin adds its mousedown handler on rootEl in bubble phase,
  // so stopping propagation here (also bubble phase) prevents it from firing.
  // React's synthetic stopPropagation alone is insufficient because React 18+
  // delegates events at the app root, not at the Lexical rootEl.
  useEffect(() => {
    const el = isolatorRef.current;
    if (!el) return;

    const stopNative = (e: Event) => {
      e.stopPropagation();
    };

    el.addEventListener('mousedown', stopNative);
    el.addEventListener('pointerdown', stopNative);
    return () => {
      el.removeEventListener('mousedown', stopNative);
      el.removeEventListener('pointerdown', stopNative);
    };
  }, []);

  return (
    <div
      ref={isolatorRef}
      className="query-block-preview-isolator"
    >
      <QueryNodeCollection
        nodeId={serverId}
        nodeUuid={blockId}
        nodeName={graphNode?.name}
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
        queryAST={queryAST}
        onQueryASTChange={saveQueryAST}
      >
        {({ results }) => {
          return <div className="query-block-results query-block-results--inline">{results}</div>;
        }}
      </QueryNodeCollection>
    </div>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────

export function QueryBlockPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [queryBlocks, setQueryBlocks] = useState<QueryBlockInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Keep a ref to the previous block list to avoid unnecessary state updates
  // that would remount portals and lose component state (e.g. open modals)
  const prevBlocksRef = useRef<QueryBlockInfo[]>([]);

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

      // Only update state if the block list actually changed
      // Compare by blockId+serverId+container identity to avoid remounting portals
      const prev = prevBlocksRef.current;
      const changed =
        prev.length !== infos.length ||
        infos.some((info, i) =>
          prev[i].blockId !== info.blockId ||
          prev[i].serverId !== info.serverId ||
          prev[i].container !== info.container
        );

      if (changed) {
        prevBlocksRef.current = infos;
        setQueryBlocks(infos);
      }
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
