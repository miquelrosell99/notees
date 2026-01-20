/**
 * ContentWithPills Component
 * 
 * Renders text content with [[linkId]] links displayed as clickable pill elements.
 * All links use the unified [[nodeId]] format - the node type (page/block) is
 * determined by looking up the node.
 * 
 * Features:
 * - Links rendered as rounded rectangle pills
 * - Click to navigate to linked page/block
 * - Shift+click to open in sidebar
 * - Right-click context menu
 * - Click count badge display
 */
import { useMemo, useCallback, useState } from 'react';
import { useLinkClicks, useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import { ContextMenu } from './core/ContextMenu';
import type { ContextMenuItem } from './core/ContextMenu';
import type { Node } from '@/types';
import { NodeIcon } from './icons';
import './LinkPill.css';

// Regex for finding links - unified [[linkId]] format
const LINK_REGEX = /\[\[([^\]]+)\]\]/g;

interface LinkPart {
  type: 'text' | 'link';
  content: string;
  linkId?: string;  // The node ID for links
  raw?: string;
}

interface ContentWithPillsProps {
  content: string;
  blockId?: number;
  onClick?: () => void;
  className?: string;
}

/**
 * Parse content into parts (text and links)
 */
function parseContent(content: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let lastIndex = 0;
  let match;
  
  const regex = new RegExp(LINK_REGEX.source, 'g');
  
  while ((match = regex.exec(content)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: content.substring(lastIndex, match.index),
      });
    }
    
    const raw = match[0];
    const linkId = match[1];
    
    parts.push({
      type: 'link',
      content: linkId,
      linkId: linkId,
      raw,
    });
    
    lastIndex = match.index + match[0].length;
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
        <span className="link-pill__icon">
          <NodeIcon icon={node?.icon} isPage={isPage} size="xs" />
        </span>
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

export function ContentWithPills({
  content,
  blockId,
  onClick,
  className = '',
}: ContentWithPillsProps) {
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
      <span className={`content-with-pills ${className}`} onClick={onClick}>
        {content}
      </span>
    );
  }
  
  return (
    <span className={`content-with-pills ${className}`} onClick={onClick}>
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return <span key={index}>{part.content}</span>;
        }
        
        return (
          <LinkPill
            key={index}
            linkId={part.linkId!}
            raw={part.raw!}
            clickCount={clickCounts.get(part.linkId!) ?? 0}
            onNavigate={handleNavigate}
          />
        );
      })}
    </span>
  );
}

export default ContentWithPills;
