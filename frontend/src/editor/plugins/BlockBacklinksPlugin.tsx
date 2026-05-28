/**
 * BlockBacklinksPlugin — Handles backlink count badge clicks and renders
 * inline linked references preview below blocks.
 *
 * The badge DOM is created by BlockNode.createDOM(). This plugin adds
 * click handling via event delegation and renders the expanded linked
 * references view into the preview container via portals.
 */

import { useEffect, useState, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useVirtualization } from './VirtualizationPlugin';
import { QuerySection } from '@/components/nodes/QuerySection';
import { useNavigationStore } from '@/stores';

interface ExpandedBlockInfo {
  blockId: string;
  serverId: number;
  container: HTMLElement;
}

function BacklinkPreview({ serverId }: { serverId: number }): JSX.Element {
  const openNode = useNavigationStore(state => state.openNode);
  const addSidebarCard = useNavigationStore(state => state.addSidebarCard);

  return (
    <div
      style={{ padding: '8px 0' }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <QuerySection
        nodeId={serverId}
        nodeUuid=""
        viewType="linked_references"
        title="Linked References"
        defaultExpanded={true}
        hideWhenEmpty={true}
        onNodeClick={(id) => openNode(id)}
        onBlockCreated={(id) => addSidebarCard(id, 'block')}
        hideViewManagement={true}
      />
    </div>
  );
}

export function BlockBacklinksPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  useVirtualization();
  const [expandedBlocks, setExpandedBlocks] = useState<ExpandedBlockInfo[]>([]);
  const expandedIdsRef = useRef<Set<string>>(new Set());

  // Keep ref in sync with state for event handler access
  useEffect(() => {
    expandedIdsRef.current = new Set(expandedBlocks.map(b => b.blockId));
  }, [expandedBlocks]);

  // Event delegation for backlink badge clicks
  useEffect(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const badge = target.closest('.node-block-backlink-count') as HTMLElement | null;
      if (!badge) return;

      const blockEl = badge.closest('.node-block') as HTMLElement | null;
      if (!blockEl) return;

      const blockId = blockEl.dataset.blockId;
      if (!blockId) return;

      e.stopPropagation();
      e.preventDefault();

      const isExpanded = blockEl.classList.toggle('node-block--backlinks-expanded');

      if (isExpanded) {
        // Find the preview container and server ID
        const runtime = getNodeGraphRuntime();
        const graphNode = runtime.getNode(blockId);
        const serverId = graphNode?.serverId;
        if (!serverId) return;

        const preview = blockEl.querySelector('.node-block-backlinks-preview') as HTMLElement | null;
        if (!preview) return;

        setExpandedBlocks(prev => {
          if (prev.some(b => b.blockId === blockId)) return prev;
          return [...prev, { blockId, serverId, container: preview }];
        });
      } else {
        setExpandedBlocks(prev => prev.filter(b => b.blockId !== blockId));
      }
    };

    rootEl.addEventListener('click', handleClick);
    return () => rootEl.removeEventListener('click', handleClick);
  }, [editor]);

  // Remove stale expanded blocks when they're no longer in the DOM
  useEffect(() => {
    const timer = setInterval(() => {
      setExpandedBlocks(prev => {
        const filtered = prev.filter(info => {
          const dom = editor.getElementByKey(
            editor.getEditorState().read(() => {
              const root = $getRoot();
              for (const child of root.getChildren()) {
                if ($isBlockNode(child) && child.getBlockId() === info.blockId) {
                  return child.getKey();
                }
              }
              return null;
            }) ?? ''
          );
          return dom?.isConnected ?? false;
        });
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [editor]);

  if (expandedBlocks.length === 0) return null;

  return (
    <>
      {expandedBlocks.map(info => (
        createPortal(
          <BacklinkPreview serverId={info.serverId} />,
          info.container,
          info.blockId
        )
      ))}
    </>
  );
}
