/**
 * InlineContentStatic — Read-only rendering of a block's content AST.
 *
 * Used by BlockRow when the block is not actively being edited. Rendering the
 * content as plain React DOM avoids mounting a full inline editor instance for
 * every visible block, which is the main source of heap pressure on large pages.
 *
 * Visual styling mirrors InlineEditor so the switch to edit mode is seamless.
 */

import React, { useCallback, useRef, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import type { ContentAST } from '@/runtime/types';
import type { ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { formatDateRange } from '@/utils/dateRange';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
import { NodeLinkContextMenuTrigger } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useReferencedNode } from '@/features/content';
import { useBatchedNodeByUuid } from '@/hooks';
import { getLogicalOffsetFromPoint } from './utils/cursorOffsetFromPoint';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import '@/styles/inline-link.css';
import '@/styles/math.css';
import './InlineContentStatic.css';

interface InlineContentStaticProps {
  /** Block content AST (JSON string or already-parsed AST). */
  name: string;
  /** Placeholder shown when the content is empty. */
  placeholder?: string;
  /** Block UUID, used for data attributes and click handling. */
  blockId: string;
  /** Called when the user clicks the static content to enter edit mode. */
  onFocus?: (cursorOffset?: number) => void;
  /**
   * Called with the serialized AST after a pill context-menu edit
   * (Delete / Unlink). When omitted, those actions are not offered.
   */
  onContentEdit?: (content: string) => void;
  /** Whether this block is a page title block. */
  isPage?: boolean;
  /** Whether the containing block has a node color applied. */
  hasNodeColor?: boolean;
  /** Whether this editor is rendered inside a card context. */
  inCard?: boolean;
  /** Whether this editor is a card title block. */
  cardTitle?: boolean;
  /** Compact list-view size context. */
  listSize?: 'sm' | 'md';
  /** Whether this editor is rendered inside a property text block editor. */
  inPropertyEditor?: boolean;
  /** Additional CSS class. */
  className?: string;
}

// ─── Pill mutation helpers (Delete / Unlink from the static view) ────

interface PillActions {
  onRemove: (linkId: string) => void;
  onUnlink: (linkId: string, keepText: string) => void;
}

function linkIdOfNode(node: ASTInlineNode): string | null {
  if (node.type === 'node_link' || node.type === 'broken_link') return node.link_id;
  if (node.type === 'external_link') return node.url;
  return null;
}

function mutateLinkInInlines(
  nodes: ASTInlineNode[],
  linkId: string,
  replacement: ASTInlineNode | null,
): ASTInlineNode[] {
  const out: ASTInlineNode[] = [];
  for (const node of nodes) {
    if (linkIdOfNode(node) === linkId) {
      if (replacement) out.push(replacement);
      continue;
    }
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) {
      out.push({
        ...node,
        children: mutateLinkInInlines(children as ASTInlineNode[], linkId, replacement),
      } as ASTInlineNode);
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Remove a link pill (replacement null) or replace it with a text node. */
function mutateLinkInDocument(
  ast: ContentAST,
  linkId: string,
  replacement: ASTInlineNode | null,
): ContentAST {
  return ast.map((block) => {
    const children = (block as { children?: unknown }).children;
    if (!Array.isArray(children)) return block;
    return {
      ...block,
      children: mutateLinkInInlines(children as ASTInlineNode[], linkId, replacement),
    } as ContentAST[number];
  });
}

function renderMath(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return displayMode
      ? `<div class="katex-error">$$${expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$$</div>`
      : `<span class="katex-error">$${expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$</span>`;
  }
}

function InlineLinkWrapper({ nodeUuid, children }: { nodeUuid: string; children: React.ReactNode }) {
  const openNode = useNavigationStore((s) => s.openNode);
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const refNode = useReferencedNode(nodeUuid);
  const { data: fallback } = useBatchedNodeByUuid(!refNode ? nodeUuid : null, { skipGlobalError: true });
  const node = refNode ?? fallback ?? null;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!node) return;
      if (e.shiftKey) {
        addSidebarCard(node.uuid, node.is_page ? 'page' : 'block');
      } else {
        openNode(node.uuid);
      }
    },
    [node, openNode, addSidebarCard],
  );

  // Middle-click opens the target in a new browser tab; preventDefault on
  // mousedown suppresses the browser's autoscroll mode.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 1 || !node) return;
      e.preventDefault();
      window.open(`/${workspaceId ?? ''}/${node.uuid}`, '_blank', 'noopener,noreferrer');
    },
    [node, workspaceId],
  );

  return (
    <span className="inline-link-wrapper" onClick={handleClick} onMouseDown={handleMouseDown}>
      {children}
    </span>
  );
}

function renderInlineNodes(nodes: ASTInlineNode[], pillActions?: PillActions): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text || null;
      case 'code':
        return (
          <code key={i} className="inline-code">
            {node.text}
          </code>
        );
      case 'node_link': {
        const { nodeUuid } = parseLinkId(node.link_id);
        return (
          <InlineLinkWrapper key={i} nodeUuid={nodeUuid}>
            <NodeLinkContextMenuTrigger
              linkId={node.link_id}
              refType={node.ref_type}
              label={node.label}
              nodeUuid={nodeUuid}
              onRemove={pillActions ? () => pillActions.onRemove(node.link_id) : undefined}
              onUnlink={pillActions ? (keepText) => pillActions.onUnlink(node.link_id, keepText) : undefined}
            >
              <NodeRef
                variant="inline"
                nodeUuid={nodeUuid}
                refType={node.ref_type === 'class' ? 'class' : 'node'}
                customName={node.label ?? undefined}
              />
            </NodeLinkContextMenuTrigger>
          </InlineLinkWrapper>
        );
      }
      case 'broken_link': {
        const text = node.label || node.link_id.split(':')[0] || '⛓️‍💥';
        return (
          <NodeLinkContextMenuTrigger
            key={i}
            linkId={node.link_id}
            refType="broken"
            label={node.label}
            onRemove={pillActions ? () => pillActions.onRemove(node.link_id) : undefined}
            onUnlink={pillActions ? (keepText) => pillActions.onUnlink(node.link_id, keepText) : undefined}
          >
            <span className="broken-link" title={`Broken link: ${node.link_id}`}>
              {text}
            </span>
          </NodeLinkContextMenuTrigger>
        );
      }
      case 'strong':
        return <strong key={i}>{renderInlineNodes(node.children, pillActions)}</strong>;
      case 'em':
        return <em key={i}>{renderInlineNodes(node.children, pillActions)}</em>;
      case 'strikethrough':
        return <s key={i}>{renderInlineNodes(node.children, pillActions)}</s>;
      case 'highlight':
        return <mark key={i}>{renderInlineNodes(node.children, pillActions)}</mark>;
      case 'underline':
        return <u key={i}>{renderInlineNodes(node.children, pillActions)}</u>;
      case 'external_link':
        return (
          <a key={i} href={node.url} target="_blank" rel="noreferrer">
            {renderInlineNodes(node.children, pillActions)}
          </a>
        );
      case 'hard_break':
        return <br key={i} />;
      case 'math': {
        const html = renderMath(node.expression, node.displayMode ?? false);
        return (
          <span
            key={i}
            className={node.displayMode ? 'math-wrapper math-wrapper--display' : 'math-wrapper'}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }
      case 'date_range': {
        const label = node.label || formatDateRange(node);
        return (
          <InlineLinkWrapper key={i} nodeUuid={node.start_uuid}>
            <span className="inline-date-range-pill" title={`${node.start} → ${node.end}`}>
              {label}
            </span>
          </InlineLinkWrapper>
        );
      }
      default:
        return null;
    }
  });
}

function isContentEmpty(ast: ContentAST): boolean {
  for (const block of ast) {
    if (block.type === 'paragraph' || block.type === 'heading') {
      const children = 'children' in block ? block.children : [];
      for (const child of children) {
        if (child.type === 'text' && child.text.trim().length > 0) return false;
        if (child.type !== 'text') return false;
      }
    }
  }
  return true;
}

export function InlineContentStatic({
  name,
  placeholder,
  blockId,
  onFocus,
  onContentEdit,
  isPage,
  hasNodeColor,
  inCard,
  cardTitle,
  listSize,
  inPropertyEditor,
  className = '',
}: InlineContentStaticProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const ast = parseAST(name) as ContentAST;
  const inlines = ast.flatMap((block) =>
    block.type === 'paragraph' || block.type === 'heading' ? (block.children as ASTInlineNode[]) : [],
  );

  const handleDeletePill = useCallback(
    (linkId: string) => {
      onContentEdit?.(JSON.stringify(mutateLinkInDocument(ast, linkId, null)));
    },
    [ast, onContentEdit],
  );

  const handleUnlinkPill = useCallback(
    (linkId: string, keepText: string) => {
      onContentEdit?.(JSON.stringify(mutateLinkInDocument(ast, linkId, { type: 'text', text: keepText })));
    },
    [ast, onContentEdit],
  );

  const pillActions = onContentEdit
    ? { onRemove: handleDeletePill, onUnlink: handleUnlinkPill }
    : undefined;
  const content = renderInlineNodes(inlines, pillActions);
  const showPlaceholder = isContentEmpty(ast);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!rootRef.current) return;
      const offset = getLogicalOffsetFromPoint(rootRef.current, e.clientX, e.clientY);
      onFocus?.(offset ?? undefined);
    },
    [onFocus],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onFocus?.();
      }
    },
    [onFocus],
  );

  return (
    <div
      ref={rootRef}
      className={`inline-content-static ${className}`}
      data-block-id={blockId}
      data-page={isPage || undefined}
      data-has-node-color={hasNodeColor || undefined}
      data-in-card={inCard || undefined}
      data-card-title={cardTitle || undefined}
      data-list-size={listSize || undefined}
      data-property-editor={inPropertyEditor || undefined}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label="Edit block"
      onKeyDown={handleKeyDown}
    >
      {showPlaceholder && placeholder ? (
        <span className="inline-content-static__placeholder">{placeholder}</span>
      ) : (
        content
      )}
    </div>
  );
}
