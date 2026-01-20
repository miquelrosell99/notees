/**
 * FormattedContent Component
 * 
 * Renders node content with interactive links, click tracking badges,
 * and context menu support.
 * 
 * Features:
 * - Parses [[page links]] and ((block refs)) into clickable elements
 * - Shows click count badges on links
 * - Tracks link clicks for analytics
 * - Right-click context menu to reset click counts
 */
import { useState, useCallback, useMemo, useEffect, Fragment } from 'react';
import { useNodeByUuid, useTrackLinkClick, useResetLinkClick } from '@/hooks';
import { useNodesStore } from '@/stores';
import { ContextMenu, type ContextMenuItem } from './core/ContextMenu';
import type { Node } from '@/types';
import './FormattedContent.css';

interface ParsedSegment {
  type: 'text' | 'page-link' | 'block-link';
  content: string;
  target?: string; // Page name or block UUID
}

/**
 * Parse content into segments of text and links
 */
function parseContent(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let lastIndex = 0;
  
  // Combined pattern to find all links in order
  const combinedPattern = /\[\[([^\]]+)\]\]|\(\(([a-f0-9-]{36})\)\)/g;
  let match;
  
  while ((match = combinedPattern.exec(content)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      });
    }
    
    // Determine link type
    if (match[1] !== undefined) {
      // Page link [[...]]
      segments.push({
        type: 'page-link',
        content: match[0],
        target: match[1],
      });
    } else if (match[2] !== undefined) {
      // Block link ((...))
      segments.push({
        type: 'block-link',
        content: match[0],
        target: match[2],
      });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }
  
  return segments;
}

interface FormattedContentProps {
  /** Source node ID (for tracking) */
  sourceNodeId: number;
  /** The raw content to format */
  content: string;
  /** Called when a page link is clicked */
  onPageClick?: (pageName: string, pageId?: number) => void;
  /** Called when a block link is clicked */
  onBlockClick?: (blockUuid: string, blockId?: number) => void;
  /** Extra CSS class */
  className?: string;
}

/**
 * Single page link with click tracking
 */
function PageLink({ 
  pageName, 
  clickCount,
  onClickLink,
  onResetCount,
}: {
  pageName: string;
  clickCount?: number;
  onClickLink: (pageName: string, pageNode?: Node) => void;
  onResetCount: (targetId: number) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [resolvedNode] = useState<Node | null>(null);
  
  // Search for page by name
  useEffect(() => {
    // Use the search functionality to find the page
    // For now, we don't have a direct name lookup, so skip
  }, [pageName]);
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClickLink(pageName, resolvedNode || undefined);
  }, [pageName, resolvedNode, onClickLink]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (resolvedNode) {
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, [resolvedNode]);
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!resolvedNode) return [];
    return [
      {
        id: 'reset-clicks',
        label: `Reset click count${clickCount ? ` (${clickCount})` : ''}`,
        onClick: () => {
          onResetCount(resolvedNode.id);
          setContextMenu(null);
        },
      },
    ];
  }, [resolvedNode, clickCount, onResetCount]);
  
  return (
    <>
      <span
        className="formatted-content__link formatted-content__link--page"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`Go to [[${pageName}]]`}
      >
        {pageName}
        {clickCount !== undefined && clickCount > 0 && (
          <span className="formatted-content__click-badge">{clickCount}</span>
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

/**
 * Single block link with click tracking
 */
function BlockLink({ 
  blockUuid, 
  clickCount,
  onClickLink,
  onResetCount,
}: {
  blockUuid: string;
  clickCount?: number;
  onClickLink: (blockUuid: string, blockNode?: Node) => void;
  onResetCount: (targetId: number) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const { data: blockNode } = useNodeByUuid(blockUuid);
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClickLink(blockUuid, blockNode || undefined);
  }, [blockUuid, blockNode, onClickLink]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (blockNode) {
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, [blockNode]);
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!blockNode) return [];
    return [
      {
        id: 'reset-clicks',
        label: `Reset click count${clickCount ? ` (${clickCount})` : ''}`,
        onClick: () => {
          onResetCount(blockNode.id);
          setContextMenu(null);
        },
      },
    ];
  }, [blockNode, clickCount, onResetCount]);
  
  // Show block name preview if available, otherwise show uuid
  const displayText = blockNode?.name 
    ? (blockNode.name.length > 30 ? blockNode.name.slice(0, 30) + '...' : blockNode.name)
    : blockUuid.slice(0, 8) + '...';
  
  return (
    <>
      <span
        className="formatted-content__link formatted-content__link--block"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`Go to block ((${blockUuid}))`}
      >
        {displayText}
        {clickCount !== undefined && clickCount > 0 && (
          <span className="formatted-content__click-badge">{clickCount}</span>
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

/**
 * Formatted content with interactive links
 */
export function FormattedContent({
  sourceNodeId,
  content,
  onPageClick,
  onBlockClick,
  className = '',
}: FormattedContentProps) {
  const { openNode } = useNodesStore();
  const trackLinkClick = useTrackLinkClick();
  const resetLinkClick = useResetLinkClick();
  
  // Parse content into segments
  const segments = useMemo(() => parseContent(content), [content]);
  
  // Handle page link click
  const handlePageLinkClick = useCallback((pageName: string, pageNode?: Node) => {
    if (pageNode) {
      // Track the click
      trackLinkClick.mutate({ sourceNodeId, targetNodeId: pageNode.id });
      
      // Navigate to the page
      if (onPageClick) {
        onPageClick(pageName, pageNode.id);
      } else {
        openNode(pageNode.id, 'page');
      }
    } else {
      // Page not found - could create it or show error
      console.warn(`Page not found: ${pageName}`);
      if (onPageClick) {
        onPageClick(pageName);
      }
    }
  }, [sourceNodeId, trackLinkClick, onPageClick, openNode]);
  
  // Handle block link click
  const handleBlockLinkClick = useCallback((blockUuid: string, blockNode?: Node) => {
    if (blockNode) {
      // Track the click
      trackLinkClick.mutate({ sourceNodeId, targetNodeId: blockNode.id });
      
      // Navigate to the block/page - use actual node type
      if (onBlockClick) {
        onBlockClick(blockUuid, blockNode.id);
      } else {
        openNode(blockNode.id, blockNode.is_page ? 'page' : 'block');
      }
    } else {
      console.warn(`Block not found: ${blockUuid}`);
      if (onBlockClick) {
        onBlockClick(blockUuid);
      }
    }
  }, [sourceNodeId, trackLinkClick, onBlockClick, openNode]);
  
  // Handle reset click count
  const handleResetCount = useCallback((targetId: number) => {
    resetLinkClick.mutate({ sourceNodeId, targetNodeId: targetId });
  }, [sourceNodeId, resetLinkClick]);
  
  if (!content) return null;
  
  return (
    <span className={`formatted-content ${className}`}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <Fragment key={index}>{segment.content}</Fragment>;
        }
        
        if (segment.type === 'page-link' && segment.target) {
          return (
            <PageLink
              key={index}
              pageName={segment.target}
              clickCount={undefined}
              onClickLink={handlePageLinkClick}
              onResetCount={handleResetCount}
            />
          );
        }
        
        if (segment.type === 'block-link' && segment.target) {
          return (
            <BlockLink
              key={index}
              blockUuid={segment.target}
              clickCount={undefined}
              onClickLink={handleBlockLinkClick}
              onResetCount={handleResetCount}
            />
          );
        }
        
        return null;
      })}
    </span>
  );
}

export default FormattedContent;
