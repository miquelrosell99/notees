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

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLinkClicks, useNode, useTextLinks, useTrackLinkClick, useUpdateNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import { NodePill } from '../NodePill';
import { ContextMenu } from '../core/ContextMenu';
import { TextField } from '../core/TextField';
import { Button } from '../core/Button';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Node } from '@/types';
import { TagIcon } from '../icons';
import { parseAST } from '@/lib/astBuilder';
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
  onReplaceLink?: (oldLinkId: string, newNodeId: number, newLinkUuid: string) => void;
  /** Callback when a link should be removed from content. */
  onRemoveLink?: (linkId: string) => void;
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
  onRemoveLink,
}: ASTBlockContentProps) {
  const { data: linkClicksData } = useLinkClicks(blockId ?? null);
  const { data: textLinks } = useTextLinks(blockId ?? null);
  const { openNode, addSidebarCard } = useNodesStore();
  const trackLinkClick = useTrackLinkClick();
  const updateNode = useUpdateNode();
  const queryClient = useQueryClient();

  // Link name dialog state (for display-mode "Edit link text")
  const [linkNameDialog, setLinkNameDialog] = useState<{
    isOpen: boolean;
    linkUuid: string;
    currentName: string | null;
    position: { top: number; left: number };
  } | null>(null);
  const linkNameDialogRef = useRef<HTMLDivElement>(null);

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

  const handleRemoveLink = useCallback((linkId: string) => {
    if (onRemoveLink) {
      onRemoveLink(linkId);
    }
  }, [onRemoveLink]);

  // Custom label dialog handlers
  const handleCustomLabel = useCallback((linkUuid: string, position: { top: number; left: number }) => {
    const currentName = linkCustomNames.get(linkUuid) || null;
    setLinkNameDialog({ isOpen: true, linkUuid, currentName, position });
  }, [linkCustomNames]);

  const handleSaveLinkName = useCallback(async (linkUuid: string, newName: string | null) => {
    try {
      await updateLinkName(linkUuid, newName);
      queryClient.invalidateQueries({ queryKey: ['textLinks', blockId] });
      setLinkNameDialog(null);
    } catch (error) {
      console.error('Failed to update link name:', error);
    }
  }, [blockId, queryClient]);

  // Close linkNameDialog on click outside
  useEffect(() => {
    if (!linkNameDialog?.isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (linkNameDialogRef.current && !linkNameDialogRef.current.contains(e.target as globalThis.Node)) {
        setLinkNameDialog(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [linkNameDialog?.isOpen]);

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
    <>
      <span className={`block-content ${className}`} onClick={onClick}>
        {ast.map((para, pIdx) => (
          <RenderParagraph
            key={pIdx}
            paragraph={para}
            paragraphIndex={pIdx}
            clickCounts={clickCounts}
            linkCustomNames={linkCustomNames}
            onNavigate={handleNavigate}
            onColorChange={handleColorChange}
            onReplaceLink={handleReplaceLink}
            onRemoveLink={handleRemoveLink}
            onCustomLabel={handleCustomLabel}
          />
        ))}
      </span>

      {linkNameDialog?.isOpen && (
        <div
          ref={linkNameDialogRef}
          className="link-name-dialog"
          style={{
            position: 'fixed',
            top: linkNameDialog.position.top,
            left: linkNameDialog.position.left,
            zIndex: 1000,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-outline)',
            borderRadius: '8px',
            padding: '12px',
            boxShadow: 'var(--elevation-2)',
            minWidth: '250px',
          }}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onFocus={e => e.stopPropagation()}
        >
          <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 500 }}>
            Edit Link Text
          </div>
          <TextField
            value={linkNameDialog.currentName || ''}
            onChange={e => setLinkNameDialog({ ...linkNameDialog, currentName: e.target.value })}
            placeholder="Custom link text (leave empty for node name)"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveLinkName(linkNameDialog.linkUuid, linkNameDialog.currentName);
              } else if (e.key === 'Escape') {
                setLinkNameDialog(null);
              }
            }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setLinkNameDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => handleSaveLinkName(linkNameDialog.linkUuid, linkNameDialog.currentName)}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Paragraph renderer ──────────────────────────────────────────

interface RenderParagraphProps {
  paragraph: ASTParagraph;
  paragraphIndex: number;
  clickCounts: Map<string, number>;
  linkCustomNames: Map<string, string>;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
  onColorChange: (nodeId: number, color: string | null) => void;
  onReplaceLink: (linkId: string, newNode: Node) => void;
  onRemoveLink: (linkId: string) => void;
  onCustomLabel: (linkUuid: string, position: { top: number; left: number }) => void;
}

function RenderParagraph({
  paragraph,
  paragraphIndex,
  clickCounts,
  linkCustomNames,
  onNavigate,
  onColorChange,
  onReplaceLink,
  onRemoveLink,
  onCustomLabel,
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
          onNavigate={onNavigate}
          onColorChange={onColorChange}
          onReplaceLink={onReplaceLink}
          onRemoveLink={onRemoveLink}
          onCustomLabel={onCustomLabel}
        />
      ))}
    </>
  );
}

// ─── NodePill with link status detection ─────────────────────────

interface NodePillWithStatusProps {
  nodeId: number;
  clickCount: number;
  customName?: string | null;
  linkUuid?: string;
  onColorChange: (color: string | null) => void;
  onReplaceLink: (newNode: Node) => void;
  onRemove?: () => void;
  onCustomLabel?: (linkUuid: string, position: { top: number; left: number }) => void;
}

function NodePillWithStatus({
  nodeId,
  clickCount,
  customName,
  linkUuid,
  onColorChange,
  onReplaceLink,
  onRemove,
  onCustomLabel,
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
      customName={customName}
      onColorChange={onColorChange}
      onReplace={onReplaceLink}
      onRemove={onRemove}
      onCustomLabel={linkUuid && onCustomLabel ? (pillRect: DOMRect) => {
        onCustomLabel(linkUuid, { top: pillRect.bottom + 4, left: pillRect.left });
      } : undefined}
    />
  );
}

// ─── Inline node renderer ────────────────────────────────────────

interface RenderInlineProps {
  node: ASTInlineNode;
  clickCounts: Map<string, number>;
  linkCustomNames: Map<string, string>;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
  onColorChange: (nodeId: number, color: string | null) => void;
  onReplaceLink: (linkId: string, newNode: Node) => void;
  onRemoveLink: (linkId: string) => void;
  onCustomLabel: (linkUuid: string, position: { top: number; left: number }) => void;
}

function RenderInlineNode({
  node,
  clickCounts,
  linkCustomNames,
  onNavigate,
  onColorChange,
  onReplaceLink,
  onRemoveLink,
  onCustomLabel,
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
        // Extract link UUID from "nodeId:linkUuid" format
        const colonIdx = node.link_id.indexOf(':');
        const linkUuid = colonIdx >= 0 ? node.link_id.slice(colonIdx + 1) : undefined;
        const customName = linkUuid ? linkCustomNames.get(linkUuid) : undefined;
        return (
          <NodePillWithStatus
            nodeId={numericId}
            clickCount={clickCounts.get(node.link_id) ?? 0}
            customName={customName}
            linkUuid={linkUuid}
            onColorChange={color => onColorChange(numericId, color)}
            onReplaceLink={newNode => onReplaceLink(node.link_id, newNode)}
            onRemove={() => onRemoveLink(node.link_id)}
            onCustomLabel={linkUuid ? onCustomLabel : undefined}
          />", "oldString": "          <NodePillWithStatus\n            nodeId={numericId}\n            clickCount={clickCounts.get(node.link_id) ?? 0}\n            customName={customName}\n            linkUuid={linkUuid}\n            onColorChange={color => onColorChange(numericId, color)}\n            onReplaceLink={newNode => onReplaceLink(node.link_id, newNode)}\n            onRemove={() => onRemoveLink(node.link_id)}\n            onCustomLabel={linkUuid ? () => {\n              // We need the pill's position — use a small trick: find the pill DOM element\n              // The onCustomLabel on NodePill will be called which doesn't need position\n              // But we need uuid for the handler. Let's use a placeholder position.\n            } : undefined}\n          />
        );
      }
      // UUID-based link — fall back to a basic span
      return <span className="inline-link link-pill--broken" title="Unresolved link">{node.link_id}</span>;
    }

    case 'strong':
      return (
        <strong>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} onRemoveLink={onRemoveLink} onCustomLabel={onCustomLabel} />
          ))}
        </strong>
      );

    case 'em':
      return (
        <em>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} onRemoveLink={onRemoveLink} onCustomLabel={onCustomLabel} />
          ))}
        </em>
      );

    case 'code':
      return <code>{node.text}</code>;

    case 'strikethrough':
      return (
        <s>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} onRemoveLink={onRemoveLink} onCustomLabel={onCustomLabel} />
          ))}
        </s>
      );

    case 'highlight':
      return (
        <mark>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} onRemoveLink={onRemoveLink} onCustomLabel={onCustomLabel} />
          ))}
        </mark>
      );

    case 'underline':
      return (
        <u>
          {node.children.map((child, i) => (
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} onRemoveLink={onRemoveLink} onCustomLabel={onCustomLabel} />
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
            <RenderInlineNode key={i} node={child} clickCounts={clickCounts} linkCustomNames={linkCustomNames} onNavigate={onNavigate} onColorChange={onColorChange} onReplaceLink={onReplaceLink} onRemoveLink={onRemoveLink} onCustomLabel={onCustomLabel} />
          ))}
        </a>
      );

    default:
      return null;
  }
}
