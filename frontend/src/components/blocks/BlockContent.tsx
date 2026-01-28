/**
 * BlockContent Component
 * 
 * Internal component for rendering block text content with parsed tokens.
 * Not exported - only used within Block component.
 * 
 * Handles:
 * - TextToken: Plain text segments
 * - InlineLink: [[nodeId]] references as atomic inline text links
 * - TypePill: {{typeId}} inline type references  
 * - ExternalLink: [text](url) markdown links
 */
import { useMemo, useCallback, useState } from 'react';
import { useLinkClicks, useNode, useClasses, useTrackLinkClick } from '@/hooks';
import { useNodesStore } from '@/stores';
import { ContextMenu } from '../core/ContextMenu';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Node } from '@/types';
import { NodeIcon, TagIcon } from '../icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { sanitizeContent } from '@/utils/linkSanitization';
import './InlineLink.css';

// Regex patterns
const LINK_REGEX = /\[\[([^\]:\s]+)(?::([a-f0-9-]+))?\]\]/g;
const TYPE_REGEX = /\{\{([^\}]+)\}\}/g;
const MD_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

interface ContentPart {
  type: 'text' | 'link' | 'inline-type' | 'external-link';
  content: string;
  id?: string;
  raw?: string;
  linkUuid?: string;
  externalUrl?: string;
  linkText?: string;
}

export interface BlockContentProps {
  content: string;
  blockId?: number;
  onClick?: () => void;
  className?: string;
  onDeleteLink?: (raw: string) => void;
}

function parseContent(content: string): ContentPart[] {
  const sanitizedContent = sanitizeContent(content);
  const parts: ContentPart[] = [];
  
  interface Match {
    type: 'link' | 'inline-type' | 'external-link';
    id: string;
    raw: string;
    start: number;
    end: number;
    linkUuid?: string;
    externalUrl?: string;
    linkText?: string;
  }
  
  const matches: Match[] = [];
  
  // Find markdown links
  let match;
  const mdLinkRegex = new RegExp(MD_LINK_REGEX.source, 'g');
  while ((match = mdLinkRegex.exec(sanitizedContent)) !== null) {
    matches.push({
      type: 'external-link',
      id: match[2],
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      externalUrl: match[2],
      linkText: match[1],
    });
  }
  
  // Find links
  const linkRegex = new RegExp(LINK_REGEX.source, 'g');
  while ((match = linkRegex.exec(sanitizedContent)) !== null) {
    matches.push({
      type: 'link',
      id: match[1],
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      linkUuid: match[2] || undefined,
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
  
  matches.sort((a, b) => a.start - b.start);
  
  let lastIndex = 0;
  for (const m of matches) {
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
      externalUrl: m.externalUrl,
      linkText: m.linkText,
    });
    
    lastIndex = m.end;
  }
  
  if (lastIndex < sanitizedContent.length) {
    parts.push({
      type: 'text',
      content: sanitizedContent.substring(lastIndex),
    });
  }
  
  return parts;
}

interface InlineLinkProps {
  linkId: string;
  raw: string;
  linkUuid?: string;
  clickCount?: number;
  onNavigate: (linkId: string, node: Node | undefined, openInSidebar: boolean, linkUuid?: string) => void;
  onDeleteLink?: (raw: string) => void;
}

function InlineLink({ linkId, raw, linkUuid, clickCount = 0, onNavigate, onDeleteLink }: InlineLinkProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nodeId = parseInt(linkId, 10);
  const { data: node } = useNode(isNaN(nodeId) ? null : nodeId);
  const { data: allClasses } = useClasses();
  
  const displayText = useMemo(() => {
    if (!node) return `[Missing Node ${linkId}]`;
    if (!node.name || node.name.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    if (!node.is_page && node.name.length > 50) {
      return `${node.name.slice(0, 50)}...`;
    }
    return node.name;
  }, [node, linkId]);
  
  const isPage = node?.is_page ?? true;
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onNavigate(linkId, node, e.shiftKey, linkUuid);
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
  }, [linkId, node, raw, isPage, onNavigate, onDeleteLink, linkUuid]);
  
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
  
  const contextMenuItems: ContextMenuItem[] = useMemo(() => [
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
  ], [typeId, node, raw, onNavigate]);
  
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
  
  const parts = useMemo(() => parseContent(content), [content]);
  
  const clickCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (linkClicksData) {
      for (const click of linkClicksData) {
        map.set(String(click.target_node_id), click.click_count);
      }
    }
    return map;
  }, [linkClicksData]);
  
  const handleNavigate = useCallback((
    linkId: string, 
    node: Node | undefined, 
    openInSidebar: boolean, 
    linkUuid?: string
  ) => {
    if (node) {
      const viewType = node.is_page ? 'page' : 'block';
      
      if (blockId) {
        trackLinkClick.mutate({
          sourceNodeId: blockId,
          targetNodeId: node.id,
          nodeLinkUuid: linkUuid,
        });
      }
      
      if (openInSidebar) {
        addSidebarCard(node.id, viewType);
      } else {
        openNode(node.id, viewType);
      }
    } else {
      console.warn(`Node not found: ${linkId}`);
    }
  }, [openNode, addSidebarCard, blockId, trackLinkClick]);
  
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
        
        if (part.type === 'external-link') {
          return (
            <a
              key={index}
              href={part.externalUrl!}
              target="_blank"
              rel="noopener noreferrer"
              className="external-link"
              onClick={(e) => e.stopPropagation()}
            >
              {part.linkText}
            </a>
          );
        }
        
        return (
          <InlineLink
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
