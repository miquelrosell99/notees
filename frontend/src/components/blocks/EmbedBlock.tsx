/**
 * EmbedBlock — Renders an embedded node as a dashed-border card "portal".
 *
 * Displays the full content of an embedded node (name + all children)
 * within a dashed-border card. Supports full editing of the embedded node.
 *
 * Keyboard navigation:
 *   - UP at first block inside embed  → selects the embed border
 *   - [border selected] Delete/Backspace → deletes the HOST block
 *   - [border selected] Enter          → creates sibling block after host
 *   - [border selected] Escape         → deselects border
 */

import { useState, useEffect, useCallback, useRef, type JSX } from 'react';

import { generateUUID } from '@/utils/uuid';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { useContentSave } from '@/hooks/useContentSave';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { BlockList } from '@/components/blocks/BlockList';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { nodeNameToText } from '@/hooks/useStringifyAST';

import './EmbedBlock.css';
import { Icon } from '@/components/core/icons';
import { Spinner } from '@/components/core/Spinner';

// ─── Props ───────────────────────────────────────────────────────

export interface EmbedBlockProps {
  /** UUID of the node being embedded */
  embeddedNodeUuid: string;
  /** UUID of the host block (the block in the outer editor that has the embed link) */
  hostBlockId: string;
  /** Whether the embed is read-only */
  readOnly?: boolean;
  /** Called when a node pill is clicked */
  onNavigateToNode?: (linkId: string) => void;
}

// ─── Component ────────────────────────────────────────────────────

export function EmbedBlock({
  embeddedNodeUuid,
  hostBlockId,
  readOnly = false,
  onNavigateToNode,
}: EmbedBlockProps): JSX.Element {
  const [borderSelected, setBorderSelected] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch the embedded node with its children
  const { data: embeddedNode, isLoading, isError } = useNodeByUuid(embeddedNodeUuid, {
    include_children: true,
  });

  // Content and block persistence for the inner editor
  const { handleContentChange } = useContentSave();
  useBlockPersist();

  // ─── Border selection keyboard handling ──────────────────────

  const handleDeleteHostBlock = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    // Blur focus first so Lexical doesn't auto-focus the next block in a weird way
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    runtime.applyIntent({ type: 'delete_block', blockId: hostBlockId });
    runtime.flushEvents();
    setBorderSelected(false);
  }, [hostBlockId]);

  const handleCreateSiblingAfterHost = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    const hostNode = runtime.getNode(hostBlockId);
    if (!hostNode?.parentId) return;
    const newBlockId = generateUUID();
    runtime.requestFocus(newBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: hostNode.parentId,
      afterBlockId: hostBlockId,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    runtime.flushEvents();
    setBorderSelected(false);
  }, [hostBlockId]);

  // Global keydown handler when border is selected
  useEffect(() => {
    if (!borderSelected) return;

    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          e.stopPropagation();
          handleDeleteHostBlock();
          break;
        }
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          handleCreateSiblingAfterHost();
          break;
        }
        case 'Escape':
        case 'ArrowDown': {
          // Escape/down deselects border
          e.preventDefault();
          e.stopPropagation();
          setBorderSelected(false);
          // Focus into the inner editor on ArrowDown
          if (e.key === 'ArrowDown') {
            const innerEditor = containerRef.current?.querySelector('.inline-editor__content') as HTMLElement | null;
            innerEditor?.focus();
          }
          break;
        }
        default: {
          // Any other key deselects border
          setBorderSelected(false);
          break;
        }
      }
    };

    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [borderSelected, handleDeleteHostBlock, handleCreateSiblingAfterHost]);

  // Click outside deselects border
  useEffect(() => {
    if (!borderSelected) return;

    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        setBorderSelected(false);
      }
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [borderSelected]);

  // ─── Inner content change handler ─────────────────────────

  const handleInnerContentChange = useCallback((blockId: string, content: string) => {
    // BlockList passes UUIDs; look up server ID via runtime
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      handleContentChange(serverId, content);
    }
  }, [handleContentChange]);

  // ─── Render states ─────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="embed-block-card">
        <div className="embed-block-header">
          <span className="embed-block-header__icon">
            <Icon path={"mdi mdi-cube-outline"} size="14px" />
          </span>
          <span className="embed-block-header__label"><Spinner size="sm" label="Loading embed…" /></span>
        </div>
        <div className="embed-block-loading"><Spinner size="sm" label="Loading…" /></div>
      </div>
    );
  }

  if (isError || !embeddedNode) {
    return (
      <div className="embed-block-card">
        <div className="embed-block-header">
          <span className="embed-block-header__icon">
            <Icon path={"mdi mdi-cube-outline"} size="14px" />
          </span>
          <span className="embed-block-header__label">Embed not found</span>
        </div>
        <div className="embed-block-error">Could not load embedded node.</div>
      </div>
    );
  }

  const embeddedName = nodeNameToText(embeddedNode.name) || '[Untitled]';

  return (
    <div role="button" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
      ref={containerRef}
      className={`embed-block-card${borderSelected ? ' embed-block-card--border-selected' : ''}`}
      tabIndex={0}
      onClick={() => borderSelected && setBorderSelected(false)}
    >
      {/* Header bar showing the embed origin */}
      <div className="embed-block-header">
        <span className="embed-block-header__icon">
          <Icon path={"mdi mdi-cube-outline"} size="14px" />
        </span>
        <span className="embed-block-header__label" title={embeddedName}>
          Embed: {embeddedName}
        </span>
        {borderSelected && (
          <span className="embed-block-header__hint">
            ↵ add block · ⌫ delete embed · ↓ enter
          </span>
        )}
      </div>

      {/* Editorial content — the embedded node's name + children */}
      <div className="embed-block-content">
        <BlockList
          nodes={[embeddedNode]}
          readOnly={readOnly}
          onContentChange={handleInnerContentChange}
          onNavigateToNode={onNavigateToNode}
          nodeUuid={embeddedNode.uuid}
        />
      </div>
    </div>
  );
}


