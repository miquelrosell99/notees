/**
 * ASTBlockContent — Read-only AST renderer.
 *
 * Replaces the legacy regex-based BlockContent.
 * Renders an ASTDocument as React elements:
 *   - text → <span>
 *   - node_link → <NodePill> (both regular and class refs)
 *   - strong → <strong>
 *   - em → <em>
 *   - code → <code>
 *   - strikethrough → <s>
 *   - highlight → <mark>
 *   - external_link → <a>
 *   - hard_break → <br>
 */

import { useMemo, useCallback, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLinkClicks, useNode, useTextLinks, useTrackLinkClick, useUpdateNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import { NodePill } from '../NodePill';
import { LinkEditorCard } from '../LinkEditorCard';
import type { Node } from '@/types';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { updateLinkName } from '@/api/nodes';
import type {
  ASTInlineNode,
  ASTParagraph,
} from '@/types/ast';

// ─── Props ────────────────────────────────────────────────────────

export interface ASTBlockContentProps {
  /** The raw content string (JSON-serialized AST). */
  content: string;
  /** Block node ID for link tracking. */
  blockId?: number;
  /** Click handler for the whole content area. */
  onClick?: () => void;
  /** Additional CSS class. */
  className?: string;
  /** Callback when a link should be replaced with a different node. */
  onReplaceLink?: (oldLinkId: string, newNodeId: number, newNodeUuid: string, newLinkUuid: string) => void;
  /** Callback when a link should be removed from content. */
  onRemoveLink?: (linkId: string) => void;
}

// ─── Main component ───────────────────────────────────────────────

export function ASTBlockContent({
  content,
  blockId,
  onClick,
  className = '',
  onReplaceLink,
  onRemoveLink,
}: ASTBlockContentProps) {
  const { data: linkClicksData } = useLinkClicks(blockId ?? null);
  const { data: textLinks } = useTextLinks(blockId ?? null);
  const { openNode, addSidebarCard } = useNodesStore();
  const trackLinkClick = useTrackLinkClick();
  const updateNode = useUpdateNode();
  const queryClient = useQueryClient();

  // Link editor card state (unified edit link target + custom text)
  const [linkEditorCard, setLinkEditorCard] = useState<{
    isOpen: boolean;
    linkId: string;
    linkUuid: string;
    currentNodeId: number | null;
    currentName: string | null;
    position: { top: number; left: number };
  } | null>(null);

  // Parse content to AST
  const ast = useMemo(() => parseAST(content), [content]);

  // Map of link UUID → custom display name (from node_link.name)
  const linkCustomNames = useMemo(() => {
    const map = new Map<string, string>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.uuid && link.name) {
          map.set(link.uuid, link.name);
        }
      }
    }
    return map;
  }, [textLinks]);

  // Map of link UUID → target node ID (from node_link.target_node_id)
  // Canonical way to resolve link targets — NOT from AST nodeUuid
  const linkTargets = useMemo(() => {
    const map = new Map<string, number>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.uuid) {
          map.set(link.uuid, link.target_node_id);
        }
      }
    }
    return map;
  }, [textLinks]);

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

  const handleSaveLinkEditor = useCallback(async (linkUuid: string, newNodeId: number, newNodeUuid: string, newCustomName: string | null) => {
    try {
      if (!linkEditorCard) return;
      const oldLinkId = linkEditorCard.linkId;
      const oldTargetId = linkEditorCard.currentNodeId;

      // If node target changed, notify parent
      if (newNodeId !== oldTargetId && onReplaceLink) {
        const newLinkUuid = crypto.randomUUID();
        onReplaceLink(oldLinkId, newNodeId, newNodeUuid, newLinkUuid);
        // Save custom name on the new link UUID
        if (newCustomName) {
          await updateLinkName(newLinkUuid, newCustomName);
        }
      } else {
        // Same target — just update custom name
        await updateLinkName(linkUuid, newCustomName);
      }

      queryClient.invalidateQueries({ queryKey: ['textLinks', blockId] });
      setLinkEditorCard(null);
    } catch (error) {
      console.error('Failed to save link editor:', error);
    }
  }, [linkEditorCard, blockId, queryClient, onReplaceLink]);

  const contentRef = useRef<HTMLSpanElement>(null);

  // Unified link editor handler
  const handleEditLink = useCallback((linkId: string, pillRect: DOMRect) => {
    const parsed = parseLinkId(linkId);
    const linkUuid = parsed.linkUuid || linkId;
    const currentName = linkCustomNames.get(linkUuid) || null;
    // Resolve target via node_link table, NOT from AST nodeUuid
    const targetNodeId = linkTargets.get(linkUuid) ?? null;
    // Compute position relative to the content container (absolute positioning)
    const containerRect = contentRef.current?.getBoundingClientRect();
    const top = containerRect
      ? pillRect.bottom - containerRect.top + 4
      : pillRect.bottom + 4;
    const left = containerRect
      ? pillRect.left - containerRect.left
      : pillRect.left;
    setLinkEditorCard({
      isOpen: true,
      linkId,
      linkUuid,
      currentNodeId: targetNodeId,
      currentName,
      position: { top, left },
    });
  }, [linkCustomNames, linkTargets]);

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
    <span ref={contentRef} className={`block-content ${className}`} style={{ position: 'relative' }} onClick={onClick}>
      {ast.map((para, pIdx) => (
        <RenderParagraph
          key={pIdx}
          paragraph={para}
          paragraphIndex={pIdx}
          clickCounts={clickCounts}
          linkCustomNames={linkCustomNames}
          linkTargets={linkTargets}
          onNavigate={handleNavigate}
          onColorChange={handleColorChange}
          onRemoveLink={linkId => onRemoveLink?.(linkId)}
          onEditLink={handleEditLink}
        />
      ))}

      {linkEditorCard?.isOpen && (
        <LinkEditorCard
          mode="node"
          linkUuid={linkEditorCard.linkUuid}
          currentNodeId={linkEditorCard.currentNodeId}
          currentCustomName={linkEditorCard.currentName}
          position={linkEditorCard.position}
          onSave={handleSaveLinkEditor}
          onDelete={() => {
            if (linkEditorCard.linkId) {
              onRemoveLink?.(linkEditorCard.linkId);
            }
            setLinkEditorCard(null);
          }}
          onClose={() => setLinkEditorCard(null)}
        />
      )}
    </span>
  );
}

// ─── Paragraph renderer ──────────────────────────────────────────

interface RenderParagraphProps {
  paragraph: ASTParagraph;
  paragraphIndex: number;
  clickCounts: Map<string, number>;
  linkCustomNames: Map<string, string>;
  linkTargets: Map<string, number>;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
  onColorChange: (nodeId: number, color: string | null) => void;
  onRemoveLink: (linkId: string) => void;
  onEditLink: (linkId: string, pillRect: DOMRect) => void;
}

function RenderParagraph({
  paragraph,
  paragraphIndex,
  clickCounts,
  linkCustomNames,
  linkTargets,
  onNavigate,
  onColorChange,
  onRemoveLink,
  onEditLink,
}: RenderParagraphProps) {
  return (
    <>
      {paragraphIndex > 0 && <br />}
      {paragraph.children.map((node, idx) => (
        <RenderInlineNode
          key={`${paragraphIndex}-${idx}`}
          node={node}
          clickCounts={clickCounts}
          linkCustomNames={linkCustomNames}
          linkTargets={linkTargets}
          onNavigate={onNavigate}
          onColorChange={onColorChange}
          onRemoveLink={onRemoveLink}
          onEditLink={onEditLink}
        />
      ))}
    </>
  );
}

// ─── NodePill with link status detection ─────────────────────────

interface NodePillWithStatusProps {
  nodeId: number | undefined;
  clickCount: number;
  customName?: string | null;
  linkId: string;
  refType: 'node' | 'class';
  /** Color change callback that includes the resolved numeric nodeId */
  onColorChangeWithId: (nodeId: number, color: string | null) => void;
  onRemove?: () => void;
  onEditLink?: (pillRect: DOMRect) => void;
}

function NodePillWithStatus({
  nodeId,
  clickCount,
  customName,
  linkId: _linkId,
  refType,
  onColorChangeWithId,
  onRemove,
  onEditLink,
}: NodePillWithStatusProps) {
  const { data: node, isError } = useNode(nodeId ?? null);

  // If the node failed to load or returned null, render as broken link
  if (isError || (!nodeId && nodeId !== 0) || (node === null)) {
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
      customName={customName}
      refType={refType}
      onColorChange={node ? (color => onColorChangeWithId(node.id, color)) : undefined}
      onRemove={onRemove}
      onEditLink={onEditLink}
    />
  );
}

// ─── Inline node renderer ────────────────────────────────────────

interface RenderInlineProps {
  node: ASTInlineNode;
  clickCounts: Map<string, number>;
  linkCustomNames: Map<string, string>;
  linkTargets: Map<string, number>;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
  onColorChange: (nodeId: number, color: string | null) => void;
  onRemoveLink: (linkId: string) => void;
  onEditLink: (linkId: string, pillRect: DOMRect) => void;
}

function RenderInlineNode({
  node,
  clickCounts,
  linkCustomNames,
  linkTargets,
  onNavigate,
  onColorChange,
  onRemoveLink,
  onEditLink,
}: RenderInlineProps) {
  switch (node.type) {
    case 'text':
      return <span>{node.text}</span>;

    case 'hard_break':
      return <br />;

    case 'node_link': {
      // All node links (both regular and class refs) — resolve target via node_link table
      const parsed = parseLinkId(node.link_id);
      const customName = parsed.linkUuid ? linkCustomNames.get(parsed.linkUuid) : undefined;
      const targetNodeId = parsed.linkUuid ? linkTargets.get(parsed.linkUuid) : undefined;
      return (
        <NodePillWithStatus
          nodeId={targetNodeId}
          clickCount={clickCounts.get(node.link_id) ?? 0}
          customName={customName}
          linkId={node.link_id}
          refType={node.ref_type}
          onColorChangeWithId={onColorChange}
          onRemove={() => onRemoveLink(node.link_id)}
          onEditLink={(pillRect: DOMRect) => onEditLink(node.link_id, pillRect)}
        />
      );
    }

    case 'strong':
      return (
        <strong>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} linkTargets={linkTargets} onNavigate={onNavigate} onColorChange={onColorChange} onRemoveLink={onRemoveLink} onEditLink={onEditLink} />
          ))}
        </strong>
      );

    case 'em':
      return (
        <em>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} linkTargets={linkTargets} onNavigate={onNavigate} onColorChange={onColorChange} onRemoveLink={onRemoveLink} onEditLink={onEditLink} />
          ))}
        </em>
      );

    case 'code':
      return <code>{node.text}</code>;

    case 'strikethrough':
      return (
        <s>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} linkTargets={linkTargets} onNavigate={onNavigate} onColorChange={onColorChange} onRemoveLink={onRemoveLink} onEditLink={onEditLink} />
          ))}
        </s>
      );

    case 'highlight':
      return (
        <mark>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} linkTargets={linkTargets} onNavigate={onNavigate} onColorChange={onColorChange} onRemoveLink={onRemoveLink} onEditLink={onEditLink} />
          ))}
        </mark>
      );

    case 'underline':
      return (
        <u>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} linkTargets={linkTargets} onNavigate={onNavigate} onColorChange={onColorChange} onRemoveLink={onRemoveLink} onEditLink={onEditLink} />
          ))}
        </u>
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
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} linkTargets={linkTargets} onNavigate={onNavigate} onColorChange={onColorChange} onRemoveLink={onRemoveLink} onEditLink={onEditLink} />
          ))}
        </a>
      );

    default:
      return null;
  }
}
