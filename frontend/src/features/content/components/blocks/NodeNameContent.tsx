/**
 * NodeNameContent — Renders a node's name as rich inline content with clickable links.
 *
 * Parses the node's AST name and renders inline elements (text, bold, links, etc.)
 * with node_link references styled identically to the block editor (dotted underline)
 * and clickable for navigation.
 */
import React, { useCallback } from 'react';
import { useParams } from 'react-router-dom';
import type { ASTInlineNode } from '@/types/ast';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { formatDateRange } from '@/utils/dateRange';
import { NodeRef } from '@/features/content/components/nodes/NodeRef';
import { NodeLinkContextMenuTrigger } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useReferencedNode } from '@/features/content';
import { useBatchedNodeByUuid } from '@/hooks';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import '@/styles/inline-link.css';
import '@/styles/math.css';

/**
 * Clickable wrapper that mimics the block editor's inline-link-wrapper.
 * Click navigates to the node; Shift+click opens in sidebar;
 * middle-click opens in a new browser tab.
 */
function InlineLinkWrapper({ nodeUuid, children }: { nodeUuid: string; children: React.ReactNode }) {
  const openNode = useNavigationStore(s => s.openNode);
  const addSidebarCard = useNavigationStore(s => s.addSidebarCard);
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { data: node } = useBatchedNodeByUuidFallback(nodeUuid);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!node) return;
    if (e.shiftKey) {
      addSidebarCard(node.uuid, node.is_page ? 'page' : 'block');
    } else {
      openNode(node.uuid);
    }
  }, [node, openNode, addSidebarCard]);

  // Middle-click opens the target in a new browser tab; preventDefault on
  // mousedown suppresses the browser's autoscroll mode.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1 || !node) return;
    e.preventDefault();
    window.open(`/${workspaceId ?? ''}/${node.uuid}`, '_blank', 'noopener,noreferrer');
  }, [node, workspaceId]);

  return (
    <span className="inline-link-wrapper" onClick={handleClick} onMouseDown={handleMouseDown}>
      {children}
    </span>
  );
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

function renderInlineNodes(nodes: ASTInlineNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text || null;
      case 'node_link': {
        const { nodeUuid } = parseLinkId(node.link_id);
        return (
          <InlineLinkWrapper key={i} nodeUuid={nodeUuid}>
            <NodeLinkContextMenuTrigger
              linkId={node.link_id}
              refType={node.ref_type}
              label={node.label}
              nodeUuid={nodeUuid}
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
          >
            <span className="broken-link" title={`Broken link: ${node.link_id}`}>
              {text}
            </span>
          </NodeLinkContextMenuTrigger>
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

export function NodeNameContent({ name }: { name: string | null | undefined }) {
  const ast = parseAST(name);
  const inlines = ast.flatMap(block => ('children' in block ? block.children : []));
  const content = renderInlineNodes(inlines as ASTInlineNode[]);
  return <>{content.length > 0 ? content : 'Untitled'}</>;
}

function useBatchedNodeByUuidFallback(nodeUuid: string) {
  const refNode = useReferencedNode(nodeUuid);
  const { data: fallback } = useBatchedNodeByUuid(!refNode ? nodeUuid : null, {
    skipGlobalError: true,
  });
  return { data: refNode ?? fallback ?? null };
}
