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
import { useNavigationStore } from '@/stores';
import { useQueryBlock } from '@/hooks/useQueryBlock';

// ─── Types ────────────────────────────────────────────────────────

interface QueryBlockInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;           // .node-block-query-preview (results)
  toolbarContainer: HTMLElement;    // .node-block-query-toolbar (controls in after-content)
}

// ─── Inner Component (per query block) ────────────────────────────

interface QueryPreviewProps {
  blockId: string;
  serverId: number;
  toolbarContainer: HTMLElement;
}

/**
 * Renders a single query block's results using QueryNodeCollection.
 * Reads the QueryAST from the node's `name` AST field (inline mode).
 *
 * Controls (filter button, view mode switcher) are portaled into the
 * `.node-block-query-toolbar` container alongside class pills.
 * Results are rendered inline in the `.node-block-query-preview` container.
 *
 * Wraps everything in an event-isolating container so that mousedown events
 * don't bubble to Lexical's handlers (BlockDragSelectionPlugin, EmptyClickPlugin,
 * BlurOnClickOutsidePlugin) which would trigger editor state changes, re-scans,
 * and remount this component — losing modal state.
 */
function QueryPreview({ blockId, serverId, toolbarContainer }: QueryPreviewProps): JSX.Element {
  const openNode = useNavigationStore(state => state.openNode);
  const openNodeInSidebar = useNavigationStore(state => state.openNodeInSidebar);
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

  // Also isolate events on the toolbar container (portaled into after-content area,
  // separate DOM subtree from the preview isolator)
  useEffect(() => {
    const el = toolbarContainer;
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
  }, [toolbarContainer]);

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
        hideToolbar={true}
        hideViewManagement={false}
        showAddButton={false}
        queryAST={queryAST}
        onQueryASTChange={saveQueryAST}
      >
        {({ results, controls }) => {
          return (
            <>
              {controls && createPortal(
                <div className="query-block-toolbar-inline">{controls}</div>,
                toolbarContainer
              )}
              <div className="query-block-results query-block-results--inline">{results}</div>
            </>
          );
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

        const toolbarContainer = blockEl.querySelector('.node-block-query-toolbar') as HTMLElement;
        if (!toolbarContainer) continue;

        // Resolve serverId from runtime
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        infos.push({ blockId, serverId: graphNode.serverId, container, toolbarContainer });
      }

      // Only update state if the block list actually changed
      // Compare by blockId+serverId+container identity to avoid remounting portals
      const prev = prevBlocksRef.current;
      const changed =
        prev.length !== infos.length ||
        infos.some((info, i) =>
          prev[i].blockId !== info.blockId ||
          prev[i].serverId !== info.serverId ||
          prev[i].container !== info.container ||
          prev[i].toolbarContainer !== info.toolbarContainer
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
      queueMicrotask(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Render portals
  if (queryBlocks.length === 0) return null;

  return (
    <>
      {queryBlocks.map(({ blockId, serverId, container, toolbarContainer }) =>
        createPortal(
          <QueryPreview
            key={blockId}
            blockId={blockId}
            serverId={serverId}
            toolbarContainer={toolbarContainer}
          />,
          container,
        ),
      )}
    </>
  );
}
