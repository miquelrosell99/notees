/**
 * ASTBlockContent — Read-only AST renderer.
 *
 * Replaces the legacy regex-based BlockContent.
 * Renders an ASTDocument as React elements:
 *   - text → <span>
 *   - node_link → <NodePill>
 *   - class refs → <TypePill>
 *   - strong → <strong>
 *   - em → <em>
 *   - code → <code>
 *   - strikethrough → <s>
 *   - highlight → <mark>
 *   - external_link → <a>
 *   - hard_break → <br>
 */

import { useMemo, useCallback, useState } from 'react';
import { useLinkClicks, useNode, useTrackLinkClick, useUpdateNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNodesStore } from '@/stores';
import { NodePill } from '../NodePill';
import { ContextMenu } from '../core/ContextMenu';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Node } from '@/types';
import { TagIcon } from '../icons';
import { parseAST } from '@/lib/astBuilder';
import type {
  ASTInlineNode,
  ASTParagraph,
} from '@/types/ast';

// ─── Props ────────────────────────────────────────────────────────

export interface ASTBlockContentProps {
  /** The raw content string (JSON-serialized AST or legacy plain text). */
  content: string;
  /** Block node ID for link tracking. */
  blockId?: number;
  /** Click handler for the whole content area. */
  onClick?: () => void;
  /** Additional CSS class. */
  className?: string;
  /** Callback when a link should be replaced with a different node. */
  onReplaceLink?: (oldLinkId: string, newNodeId: number, newLinkUuid: string) => void;
}

// ─── Internal sub-components ──────────────────────────────────────

interface TypePillDisplayProps {
  typeId: string;
  linkId: string;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
}

function TypePillDisplay({ typeId, linkId, onNavigate }: TypePillDisplayProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const parsedId = parseInt(typeId, 10);
  const { data: node } = useNode(isNaN(parsedId) ? null : parsedId);
  const displayText = nodeNameToText(node?.name) || typeId;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onNavigate(typeId, node, e.shiftKey);
  }, [typeId, node, onNavigate]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => [
    {
      id: 'open',
      label: 'Open type',
      onClick: () => { onNavigate(typeId, node, false); setContextMenu(null); },
    },
    {
      id: 'open-sidebar',
      label: 'Open in sidebar',
      shortcut: '⇧Click',
      onClick: () => { onNavigate(typeId, node, true); setContextMenu(null); },
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'copy',
      label: 'Copy reference',
      onClick: () => { navigator.clipboard.writeText(linkId); setContextMenu(null); },
    },
  ], [typeId, node, linkId, onNavigate]);

  return (
    <>
      <span
        className="class-pill"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`Class: ${displayText}\nClick to open, Shift+click for sidebar`}
      >
        <span className="class-pill__icon"><TagIcon size="xs" /></span>
        <span className="class-pill__text">{displayText}</span>
      </span>
      {contextMenu && (
        <ContextMenu items={contextMenuItems} position={contextMenu} onClose={() => setContextMenu(null)} />
      )}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────

export function ASTBlockContent({
  content,
  blockId,
  onClick,
  className = '',
  onReplaceLink,
}: ASTBlockContentProps) {
  const { data: linkClicksData } = useLinkClicks(blockId ?? null);
  const { openNode, addSidebarCard } = useNodesStore();
  const trackLinkClick = useTrackLinkClick();
  const updateNode = useUpdateNode();

  // Parse content to AST
  const ast = useMemo(() => parseAST(content), [content]);

  const clickCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (linkClicksData) {
      for (const click of linkClicksData) {
        map.set(String(click.target_node_id), click.click_count);
      }
    }
    return map;
  }, [linkClicksData]);

  const handleNavigate = useCallback((typeId: string, node: Node | undefined, openInSidebar: boolean) => {
    const id = parseInt(typeId, 10);
    if (!isNaN(id) && blockId) {
      trackLinkClick.mutate({ sourceNodeId: blockId, targetNodeId: id });
    }
    if (node) {
      if (openInSidebar) addSidebarCard(node.id, 'page');
      else openNode(node.id, 'page');
    }
  }, [blockId, trackLinkClick, openNode, addSidebarCard]);

  const handleColorChange = useCallback((nodeId: number, color: string | null) => {
    updateNode.mutate({ id: nodeId, data: { color } });
  }, [updateNode]);

  const handleReplaceLink = useCallback((linkId: string, newNode: Node) => {
    if (onReplaceLink) {
      const newLinkUuid = crypto.randomUUID();
      onReplaceLink(linkId, newNode.id, newLinkUuid);
    }
  }, [onReplaceLink]);

  // ─── Check if plain text (no AST needed) ──────────────────────
  if (ast.length === 0) {
    return <span className={`block-content ${className}`} onClick={onClick} />;
  }

  if (ast.length === 1 && ast[0].children.length === 1 && ast[0].children[0].type === 'text') {
    return (
      <span className={`block-content ${className}`} onClick={onClick}>
        {ast[0].children[0].text}
      </span>
    );
  }

  // ─── Render AST nodes as React elements ────────────────────────
  return (
    <span className={`block-content ${className}`} onClick={onClick}>
      {ast.map((para, pIdx) => (
        <RenderParagraph
          key={pIdx}
          paragraph={para}
          paragraphIndex={pIdx}
          clickCounts={clickCounts}
          onNavigate={handleNavigate}
          onColorChange={handleColorChange}
          onReplaceLink={handleReplaceLink}
        />
      ))}
    </span>
  );
}

// ─── Paragraph renderer ──────────────────────────────────────────

interface RenderParagraphProps {
  paragraph: ASTParagraph;
  paragraphIndex: number;
  clickCounts: Map<string, number>;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
  onColorChange: (nodeId: number, color: string | null) => void;
  onReplaceLink: (linkId: string, newNode: Node) => void;
}

function RenderParagraph({
  paragraph,
  paragraphIndex,
  clickCounts,
  onNavigate,
  onColorChange,
  onReplaceLink,
}: RenderParagraphProps) {
  return (
    <>
      {paragraphIndex > 0 && <br />}
      {paragraph.children.map((node, idx) => (
        <RenderInlineNode
          key={`${paragraphIndex}-${idx}`}
          node={node}
          clickCounts={clickCounts}
          onNavigate={onNavigate}
          onColorChange={onColorChange}
          onReplaceLink={onReplaceLink}
        />
      ))}
    </>
  );
}

// ─── NodePill with link status detection ─────────────────────────

interface NodePillWithStatusProps {
  nodeId: number;
  clickCount: number;
  onColorChange: (color: string | null) => void;
  onReplaceLink: (newNode: Node) => void;
}

function NodePillWithStatus({
  nodeId,
  clickCount,
  onColorChange,
  onReplaceLink,
}: NodePillWithStatusProps) {
  const { data: node, isError } = useNode(nodeId);

  // If the node failed to load or returned null, render as broken link
  if (isError || (node === null)) {
    return (
      <span className="inline-link link-pill--broken" title="Link target not found">
        <span className="link-pill__text">Deleted</span>
      </span>
    );
  }

  return (
    <NodePill
      nodeId={nodeId}
      clickCount={clickCount}
      variant="link"
      readOnly={false}
      onColorChange={onColorChange}
      onReplace={onReplaceLink}
    />
  );
}

// ─── Inline node renderer ────────────────────────────────────────

interface RenderInlineProps {
  node: ASTInlineNode;
  clickCounts: Map<string, number>;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
  onColorChange: (nodeId: number, color: string | null) => void;
  onReplaceLink: (linkId: string, newNode: Node) => void;
}

function RenderInlineNode({
  node,
  clickCounts,
  onNavigate,
  onColorChange,
  onReplaceLink,
}: RenderInlineProps) {
  switch (node.type) {
    case 'text':
      return <span>{node.text}</span>;

    case 'hard_break':
      return <br />;

    case 'node_link': {
      if (node.ref_type === 'class') {
        return (
          <TypePillDisplay
            typeId={node.link_id}
            linkId={node.link_id}
            onNavigate={onNavigate}
          />
        );
      }
      // Regular node link — render as NodePill
      const numericId = parseInt(node.link_id, 10);
      if (!isNaN(numericId)) {
        return (
          <NodePillWithStatus
            nodeId={numericId}
            clickCount={clickCounts.get(node.link_id) ?? 0}
            onColorChange={color => onColorChange(numericId, color)}
            onReplaceLink={newNode => onReplaceLink(node.link_id, newNode)}
          />
        );
      }
      // UUID-based link — fall back to a basic span
      return <span className="inline-link link-pill--broken" title="Unresolved link">{node.link_id}</span>;
    }

    case 'strong':
      return (
        <strong>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} />
          ))}
        </strong>
      );

    case 'em':
      return (
        <em>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} />
          ))}
        </em>
      );

    case 'code':
      return <code>{node.text}</code>;

    case 'strikethrough':
      return (
        <s>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} />
          ))}
        </s>
      );

    case 'highlight':
      return (
        <mark>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} />
          ))}
        </mark>
      );

    case 'external_link':
      return (
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          className="external-link"
          onClick={e => e.stopPropagation()}
        >
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} />
          ))}
        </a>
      );

    default:
      return null;
  }
}
