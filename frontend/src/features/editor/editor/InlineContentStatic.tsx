/**
 * InlineContentStatic — Read-only rendering of a block's content AST.
 *
 * Used by BlockRow when the block is not actively being edited. Rendering the
 * content as plain React DOM avoids mounting a heavy LexicalComposer for every
 * visible block, which is the main source of heap pressure on large pages.
 *
 * Visual styling mirrors InlineEditor so the switch to edit mode is seamless.
 */

import React, { useCallback, useRef, type JSX } from 'react';
import type { ContentAST } from '@/runtime/types';
import type { ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { formatDateRange } from '@/utils/dateRange';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
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

  return (
    <button type="button" className="inline-link-wrapper" onClick={handleClick}>
      {children}
    </button>
  );
}

function renderInlineNodes(nodes: ASTInlineNode[]): React.ReactNode[] {
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
            <NodeRef
              variant="inline"
              nodeUuid={nodeUuid}
              refType={node.ref_type === 'class' ? 'class' : 'node'}
              customName={node.label ?? undefined}
            />
          </InlineLinkWrapper>
        );
      }
      case 'broken_link': {
        const text = node.label || node.link_id.split(':')[0] || '⛓️‍💥';
        return (
          <span key={i} className="broken-link" title={`Broken link: ${node.link_id}`}>
            {text}
          </span>
        );
      }
      case 'strong':
        return <strong key={i}>{renderInlineNodes(node.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInlineNodes(node.children)}</em>;
      case 'strikethrough':
        return <s key={i}>{renderInlineNodes(node.children)}</s>;
      case 'highlight':
        return <mark key={i}>{renderInlineNodes(node.children)}</mark>;
      case 'underline':
        return <u key={i}>{renderInlineNodes(node.children)}</u>;
      case 'external_link':
        return (
          <a key={i} href={node.url} target="_blank" rel="noreferrer">
            {renderInlineNodes(node.children)}
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
  const content = renderInlineNodes(inlines);
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
