/**
 * BlockContent Component
 * 
 * Renders block text content with parsed tokens:
 * - TextToken: Plain text segments
 * - LinkPill: [[nodeId]] references rendered as clickable pills
 * - TypePill: {{typeId}} inline type references
 * 
 * Part of the Block hierarchy:
 * Block
 *  ├─ BlockContainer   (layout, indent, bullet, selection)
 *  ├─ BlockBullet
 *  ├─ BlockContent     ← this component
 *  │    ├─ TextToken
 *  │    ├─ LinkPill
 *  │    └─ TypePill
 *  └─ BlockChildren
 * 
 * Features:
 * - Click to navigate to linked page/block
 * - Shift+click to open in sidebar
 * - Right-click context menu
 * - Click count badge display
 */
import { useMemo, useCallback, useState } from 'react';
import { useLinkClicks, useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import { ContextMenu } from '../core/ContextMenu';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Node } from '@/types';
import { NodeIcon, TagIcon } from '../icons';
import './LinkPill.css';

// Regex for finding links - unified [[linkId]] format
const LINK_REGEX = /\[\[([^\]]+)\]\]/g;

// Regex for finding inline types - {{typeId}} format
const TYPE_REGEX = /\{\{([^\}]+)\}\}/g;

interface ContentPart {
  type: 'text' | 'link' | 'inline-type';
  content: string;
  id?: string;  // The node ID for links/types
  raw?: string;
}

interface BlockContentProps {
  content: string;
  blockId?: number;
  onClick?: () => void;
  className?: string;
}

/**
 * Parse content into parts (text, links, and inline types)
 */
function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  
  // Find all matches with their positions
  interface Match {
    type: 'link' | 'inline-type';
    id: string;
    raw: string;
    start: number;
    end: number;
  }
  
  const matches: Match[] = [];
  
  // Find links
  let match;
  const linkRegex = new RegExp(LINK_REGEX.source, 'g');
  while ((match = linkRegex.exec(content)) !== null) {
    matches.push({
      type: 'link',
      id: match[1],
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  
  // Find inline types
  const typeRegex = new RegExp(TYPE_REGEX.source, 'g');
  while ((match = typeRegex.exec(content)) !== null) {
    matches.push({
      type: 'inline-type',
      id: match[1],
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  
  // Sort by position
  matches.sort((a, b) => a.start - b.start);
  
  // Build parts
  let lastIndex = 0;
  for (const m of matches) {
    // Add text before this match
    if (m.start > lastIndex) {
      parts.push({
        type: 'text',
        content: content.substring(lastIndex, m.start),
      });
    }
    
    parts.push({
      type: m.type,
      content: m.id,
      id: m.id,
      raw: m.raw,
    });
    
    lastIndex = m.end;
  }
  
  // Add remaining text
  if (lastIndex < content.length) {
    parts.push({
      type: 'text',
      content: content.substring(lastIndex),
    });
  }
  
  return parts;
}

interface LinkPillProps {
  linkId: string;
  raw: string;
  clickCount?: number;
  onNavigate: (linkId: string, node: Node | undefined, openInSidebar: boolean) => void;
}

function LinkPill({ linkId, raw, clickCount = 0, onNavigate }: LinkPillProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nodeId = parseInt(linkId, 10);
  const { data: node } = useNode(isNaN(nodeId) ? null : nodeId);
  
  // Display the node name if available, otherwise show the ID
  const displayText = node?.name || linkId;
  const isPage = node?.is_page ?? true;
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onNavigate(linkId, node, e.shiftKey);
  }, [linkId, node, onNavigate]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    return [
      {
        id: 'open',
        label: isPage ? 'Open page' : 'Open block',
        onClick: () => {
          onNavigate(linkId, node, false);
          setContextMenu(null);
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          onNavigate(linkId, node, true);
          setContextMenu(null);
        },
      },
      { id: 'sep1', label: '', separator: true },
      {
        id: 'copy',
        label: 'Copy link',
        onClick: () => {
          navigator.clipboard.writeText(raw);
          setContextMenu(null);
        },
      },
    ];
  }, [linkId, node, raw, isPage, onNavigate]);
  
  return (
    <>
      <span
        className={`link-pill ${isPage ? 'link-pill--page' : 'link-pill--block'}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`${isPage ? 'Page' : 'Block'}: ${displayText}\nClick to open, Shift+click for sidebar`}
      >
        {/* Only show icon for pages, or for blocks that have an icon set */}
        {(isPage || node?.icon) && (
          <span className="link-pill__icon">
            <NodeIcon icon={node?.icon} isPage={isPage} size="xs" />
          </span>
        )}
        <span className="link-pill__text">{displayText}</span>
        {clickCount > 0 && (
          <span className="link-pill__badge">{clickCount}</span>
        )}
      </span>
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

interface TypePillProps {
  typeId: string;
  raw: string;
  onNavigate: (typeId: string, node: Node | undefined, openInSidebar: boolean) => void;
}

function TypePill({ typeId, raw, onNavigate }: TypePillProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nodeId = parseInt(typeId, 10);
  const { data: node } = useNode(isNaN(nodeId) ? null : nodeId);
  
  // Display the node name if available, otherwise show the ID
  const displayText = node?.name || typeId;
  
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
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    return [
      {
        id: 'open',
        label: 'Open type',
        onClick: () => {
          onNavigate(typeId, node, false);
          setContextMenu(null);
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          onNavigate(typeId, node, true);
          setContextMenu(null);
        },
      },
      { id: 'sep1', label: '', separator: true },
      {
        id: 'copy',
        label: 'Copy reference',
        onClick: () => {
          navigator.clipboard.writeText(raw);
          setContextMenu(null);
        },
      },
    ];
  }, [typeId, node, raw, onNavigate]);
  
  return (
    <>
      <span
        className="type-pill"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`Type: ${displayText}\nClick to open, Shift+click for sidebar`}
      >
        <span className="type-pill__icon">
          <TagIcon size="xs" />
        </span>
        <span className="type-pill__text">{displayText}</span>
      </span>
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

export function BlockContent({
  content,
  blockId,
  onClick,
  className = '',
}: BlockContentProps) {
  const { data: linkClicksData } = useLinkClicks(blockId ?? null);
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Parse content into parts
  const parts = useMemo(() => parseContent(content), [content]);
  
  // Build click counts map
  const clickCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (linkClicksData) {
      for (const click of linkClicksData) {
        map.set(String(click.target_node_id), click.click_count);
      }
    }
    return map;
  }, [linkClicksData]);
  
  // Handle navigation for links (by node ID)
  const handleNavigate = useCallback((linkId: string, node: Node | undefined, openInSidebar: boolean) => {
    if (node) {
      const viewType = node.is_page ? 'page' : 'block';
      if (openInSidebar) {
        addSidebarCard(node.id, viewType);
      } else {
        openNode(node.id, viewType);
      }
    } else {
      console.warn(`Node not found: ${linkId}`);
    }
  }, [openNode, addSidebarCard]);
  
  // If no links, just return plain text
  if (parts.length === 1 && parts[0].type === 'text') {
    return (
      <span className={`block-content ${className}`} onClick={onClick}>
        {content}
      </span>
    );
  }
  
  return (
    <span className={`block-content ${className}`} onClick={onClick}>
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return <span key={index}>{part.content}</span>;
        }
        
        if (part.type === 'inline-type') {
          return (
            <TypePill
              key={index}
              typeId={part.id!}
              raw={part.raw!}
              onNavigate={handleNavigate}
            />
          );
        }
        
        return (
          <LinkPill
            key={index}
            linkId={part.id!}
            raw={part.raw!}
            clickCount={clickCounts.get(part.id!) ?? 0}
            onNavigate={handleNavigate}
          />
        );
      })}
    </span>
  );
}

export default BlockContent;
