/**
 * BlockContent Component
 * 
 * Renders block text content with parsed tokens:
 * - TextToken: Plain text segments
 * - LinkPill: [[nodeId]] references rendered as atomic inline text links
 * - TypePill: {{typeId}} inline type references
 * 
 * Part of the Block hierarchy:
 * Block
 *  ├─ BlockContainer   (layout, indent, bullet, selection)
 *  ├─ BlockBullet
 *  ├─ BlockContent     ← this component
 *  │    ├─ TextToken
 *  │    ├─ LinkPill (atomic inline text links)
 *  │    └─ TypePill
 *  └─ BlockChildren
 * 
 * Features:
 * - Click to navigate to linked page/block
 * - Shift+click to open in sidebar
 * - Right-click context menu
 * - Click count badge display
 * - Icon display based on getEffectiveIcon (shows only if node has icon or inherits from type)
 * - Atomic inline behavior - cursor cannot enter links
 */
import { useMemo, useCallback, useState } from 'react';
import { useLinkClicks, useNode, useClasses, useTrackLinkClick } from '@/hooks';
import { useNodesStore } from '@/stores';
import { ContextMenu } from '../core/ContextMenu';
import { ImageModal } from '../core/ImageModal';
import { Bullet } from './Bullet';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Node } from '@/types';
import { NodeIcon, TagIcon } from '../icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { sanitizeContent } from '@/utils/linkSanitization';
import { getAssetUrl } from '@/api/assets';
import { getNodeByUuid } from '@/api/nodes';
import { useQuery } from '@tanstack/react-query';
import './LinkPill.css';

// Regex for finding links - [[nodeId]] or [[nodeId:linkUuid]] format
const LINK_REGEX = /\[\[([^\]:\s]+)(?::([a-f0-9-]+))?\]\]/g;

// Regex for finding inline types - {{typeId}} format
const TYPE_REGEX = /\{\{([^\}]+)\}\}/g;

// Regex for finding markdown images - ![alt](uuid) format
const IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

interface ContentPart {
  type: 'text' | 'link' | 'inline-type' | 'image';
  content: string;
  id?: string;  // The node ID for links/types
  raw?: string;
  linkUuid?: string;  // The unique link instance UUID (for links only)
  imageAlt?: string;  // Alt text for images
  imageUuid?: string;  // Asset UUID for images
}

interface BlockContentProps {
  content: string;
  blockId?: number;
  onClick?: () => void;
  className?: string;
  onDeleteLink?: (raw: string) => void;
}

/**
 * Parse content into parts (text, links, inline types, and images)
 * Content is automatically sanitized to remove editor artifacts.
 */
function parseContent(content: string): ContentPart[] {
  // Sanitize content first to remove editor artifacts
  const sanitizedContent = sanitizeContent(content);
  
  const parts: ContentPart[] = [];
  
  // Find all matches with their positions
  interface Match {
    type: 'link' | 'inline-type' | 'image';
    id: string;
    raw: string;
    start: number;
    end: number;
    linkUuid?: string;  // Only for links
    imageAlt?: string;  // Only for images
    imageUuid?: string;  // Only for images
  }
  
  const matches: Match[] = [];
  
  // Find links - supports [[nodeId]] and [[nodeId:linkUuid]] formats
  let match;
  const linkRegex = new RegExp(LINK_REGEX.source, 'g');
  while ((match = linkRegex.exec(sanitizedContent)) !== null) {
    matches.push({
      type: 'link',
      id: match[1],  // nodeId
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      linkUuid: match[2] || undefined,  // linkUuid (optional)
    });
  }
  
  // Find inline types
  const typeRegex = new RegExp(TYPE_REGEX.source, 'g');
  while ((match = typeRegex.exec(sanitizedContent)) !== null) {
    matches.push({
      type: 'inline-type',
      id: match[1],
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  
  // Find images - ![alt](uuid) format
  const imageRegex = new RegExp(IMAGE_REGEX.source, 'g');
  while ((match = imageRegex.exec(sanitizedContent)) !== null) {
    matches.push({
      type: 'image',
      id: match[2],  // uuid
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      imageAlt: match[1] || 'Image',
      imageUuid: match[2],
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
        content: sanitizedContent.substring(lastIndex, m.start),
      });
    }
    
    parts.push({
      type: m.type,
      content: m.id,
      id: m.id,
      raw: m.raw,
      linkUuid: m.linkUuid,
      imageAlt: m.imageAlt,
      imageUuid: m.imageUuid,
    });
    
    lastIndex = m.end;
  }
  
  // Add remaining text
  if (lastIndex < sanitizedContent.length) {
    parts.push({
      type: 'text',
      content: sanitizedContent.substring(lastIndex),
    });
  }
  
  return parts;
}

interface LinkPillProps {
  linkId: string;
  raw: string;
  linkUuid?: string;  // Unique link instance UUID for per-link click tracking
  clickCount?: number;
  onNavigate: (linkId: string, node: Node | undefined, openInSidebar: boolean, linkUuid?: string) => void;
  onDeleteLink?: (raw: string) => void;
}

/**
 * LinkPill - Inline atomic element for node links in readonly mode
 * 
 * Renders as a pill-style element in text flow.
 * Icon display uses getEffectiveIcon:
 * - Shows icon only if node has its own icon or inherits from assigned types
 * - No icon/bullet shown if getEffectiveIcon returns null/undefined
 */
function LinkPill({ linkId, raw, linkUuid, clickCount = 0, onNavigate, onDeleteLink }: LinkPillProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nodeId = parseInt(linkId, 10);
  const { data: node } = useNode(isNaN(nodeId) ? null : nodeId);
  const { data: allClasses } = useClasses();
  
  // Enhanced display resolution with better context for missing/empty nodes
  const displayText = useMemo(() => {
    if (!node) {
      return `[Missing Node ${linkId}]`;
    }
    
    if (!node.name || node.name.trim() === '') {
      if (node.is_page) {
        return '[Untitled Page]';
      } else {
        return '[Empty Block]';
      }
    }
    
    // For blocks, truncate long content with ellipsis
    if (!node.is_page && node.name.length > 50) {
      return `${node.name.slice(0, 50)}...`;
    }
    
    return node.name;
  }, [node, linkId]);
  
  const isPage = node?.is_page ?? true;
  
  // Compute effective icon - considers node's own icon and inherited class icons
  const effectiveIcon = useMemo(() => {
    return getEffectiveIcon(node, allClasses);
  }, [node, allClasses]);
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Direct graph navigation - no URL routing
    if (e.shiftKey) {
      onNavigate(linkId, node, true, linkUuid);
    } else {
      onNavigate(linkId, node, false, linkUuid);
    }
  }, [linkId, node, onNavigate, linkUuid]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: isPage ? 'Open page' : 'Open block',
        onClick: () => {
          onNavigate(linkId, node, false, linkUuid);
          setContextMenu(null);
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          onNavigate(linkId, node, true, linkUuid);
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
    
    if (onDeleteLink) {
      items.push(
        { id: 'sep2', label: '', separator: true },
        {
          id: 'delete',
          label: 'Delete link',
          danger: true,
          onClick: () => {
            onDeleteLink(raw);
            setContextMenu(null);
          },
        }
      );
    }
    
    return items;
  }, [linkId, node, raw, isPage, onNavigate, onDeleteLink]);
  
  return (
    <>
      <span
        className={`link-pill ${isPage ? 'link-pill--page' : 'link-pill--block'}${!effectiveIcon ? ' link-pill--no-icon' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        data-link-raw={raw}
        data-node-id={linkId}
        data-label={displayText}
        title={`${isPage ? 'Page' : 'Block'}: ${displayText}\nClick to open, Shift+click for sidebar`}
      >
        {/* Only show icon if getEffectiveIcon returns a value */}
        {effectiveIcon && (
          <span className="link-pill__icon">
            <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" />
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
        data-type-raw={raw}
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

interface InlineImageProps {
  uuid: string;
  alt: string;
}

/**
 * InlineImage - Renders an inline image with click-to-expand functionality and bullet
 */
function InlineImage({ uuid, alt }: InlineImageProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Fetch the asset node by UUID to get its ID
  const { data: assetNode } = useQuery({
    queryKey: ['node-by-uuid', uuid],
    queryFn: () => getNodeByUuid(uuid),
    enabled: !!uuid,
  });
  
  const imageUrl = getAssetUrl(uuid);
  
  const handleImageClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsModalOpen(true);
  }, []);
  
  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (assetNode) {
      openNode(assetNode.id, assetNode.is_page ? 'page' : 'block');
    }
  }, [assetNode, openNode]);
  
  const handleBulletShiftClick = useCallback(() => {
    if (assetNode) {
      addSidebarCard(assetNode.id, assetNode.is_page ? 'page' : 'block');
    }
  }, [assetNode, addSidebarCard]);
  
  const handleBulletContextMenu = useCallback((_nodeId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!assetNode) return [];
    
    return [
      {
        id: 'open',
        label: 'Open asset',
        onClick: () => {
          openNode(assetNode.id, assetNode.is_page ? 'page' : 'block');
          setContextMenu(null);
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          addSidebarCard(assetNode.id, assetNode.is_page ? 'page' : 'block');
          setContextMenu(null);
        },
      },
      { id: 'sep1', label: '', separator: true },
      {
        id: 'view-fullsize',
        label: 'View full size',
        onClick: () => {
          setIsModalOpen(true);
          setContextMenu(null);
        },
      },
    ];
  }, [assetNode, openNode, addSidebarCard]);
  
  if (hasError) {
    return (
      <span className="inline-image-error" title="Failed to load image">
        [Image Error: {alt}]
      </span>
    );
  }
  
  return (
    <>
      <div 
        className="inline-image-container"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <img
          src={imageUrl}
          alt={alt}
          className="inline-image"
          onClick={handleImageClick}
          onError={() => setHasError(true)}
          title="Click to view full size"
        />
      </div>
      <ImageModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        src={imageUrl}
        alt={alt}
        assetNode={assetNode}
        onBulletClick={handleBulletClick}
        onBulletShiftClick={handleBulletShiftClick}
        onBulletContextMenu={handleBulletContextMenu}
      />
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
  onDeleteLink,
}: BlockContentProps) {
  const { data: linkClicksData } = useLinkClicks(blockId ?? null);
  const { openNode, addSidebarCard } = useNodesStore();
  const trackLinkClick = useTrackLinkClick();
  
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
  
  // Enhanced navigation with explicit click tracking
  const handleNavigate = useCallback((
    linkId: string, 
    node: Node | undefined, 
    openInSidebar: boolean, 
    linkUuid?: string
  ) => {
    if (node) {
      const viewType = node.is_page ? 'page' : 'block';
      
      // Track the link click with explicit API call
      if (blockId) {
        trackLinkClick.mutate({
          sourceNodeId: blockId,
          targetNodeId: node.id,
          nodeLinkUuid: linkUuid,
        });
      }
      
      // Perform direct graph navigation
      if (openInSidebar) {
        addSidebarCard(node.id, viewType);
      } else {
        openNode(node.id, viewType);
      }
    } else {
      console.warn(`Node not found: ${linkId}`);
    }
  }, [openNode, addSidebarCard, blockId, trackLinkClick]);
  
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
        
        if (part.type === 'image') {
          return (
            <InlineImage
              key={index}
              uuid={part.imageUuid!}
              alt={part.imageAlt!}
            />
          );
        }
        
        return (
          <LinkPill
            key={index}
            linkId={part.id!}
            raw={part.raw!}
            linkUuid={part.linkUuid}
            clickCount={clickCounts.get(part.id!) ?? 0}
            onNavigate={handleNavigate}
            onDeleteLink={onDeleteLink}
          />
        );
      })}
    </span>
  );
}

export default BlockContent;
