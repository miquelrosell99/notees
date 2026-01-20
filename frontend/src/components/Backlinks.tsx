/**
 * Backlinks component for displaying references to a node
 * 
 * Shows linked references using real Block elements with breadcrumbs:
 * - Breadcrumb path shows the hierarchy (excluding the source node itself)
 * - Block content displayed as a real editable Block element
 * - Section is collapsible via NodeViewSection
 * - Supports multiple view modes via NodeSet (list, table, card)
 */
import { useMemo, useCallback } from 'react';
import './Backlinks.css';
import { useBacklinks, useLinkedReferences, usePropertyBacklinks, useUpdateNode } from '@/hooks';
import type { Backlink, LinkedReference, BreadcrumbSegment, Node } from '@/types/api';
import { LinkIcon, NodeIcon } from './icons';
import { Block } from './Block';
import { NodeViewSection } from './NodeViewSection';
import { NodeSet, type NodeSetItem } from './NodeSet';
import { 
  propertyBacklinkToPageItem,
  type PageReferenceItem,
} from '../views/ReferencesView';

interface BacklinksProps {
  nodeId: number;
  className?: string;
  onLinkClick?: (nodeId: number, pageId?: number | null, isPage?: boolean) => void;
  showContext?: boolean;
}

/**
 * Group backlinks by their source page
 */
function groupBacklinksByPage(backlinks: Backlink[]): Map<number | null, Backlink[]> {
  const groups = new Map<number | null, Backlink[]>();
  
  for (const backlink of backlinks) {
    const pageId = backlink.source_page_id;
    const existing = groups.get(pageId) ?? [];
    existing.push(backlink);
    groups.set(pageId, existing);
  }
  
  return groups;
}

/**
 * Backlinks section showing all references to this node (legacy)
 */
export function Backlinks({ 
  nodeId, 
  className = '', 
  onLinkClick,
}: BacklinksProps) {
  const { data: backlinks, isLoading, error } = useBacklinks(nodeId);

  if (isLoading) {
    return (
      <div className={`backlinks loading ${className}`}>
        <div className="backlinks-skeleton">Loading backlinks...</div>
      </div>
    );
  }

  if (error || !backlinks || backlinks.length === 0) {
    return null;
  }

  // Group backlinks by source page for better organization
  const grouped = groupBacklinksByPage(backlinks);

  return (
    <NodeViewSection
      title="Backlinks"
      icon={<LinkIcon size="sm" />}
      count={backlinks.length}
      className={className}
    >
      <div className="backlinks-groups">
        {Array.from(grouped.entries()).map(([pageId, pageBacklinks]) => (
          <div key={pageId ?? 'orphan'} className="backlinks-group">
            {pageId !== null && pageBacklinks[0].source_page_name && (
              <div className="backlinks-group-header">
                <button
                  className="backlinks-page-link"
                  onClick={() => onLinkClick?.(pageId, null, true)}
                >
                  <NodeIcon icon={null} isPage={true} size="sm" /> {pageBacklinks[0].source_page_name}
                </button>
              </div>
            )}
            
            <ul className="backlinks-list">
              {pageBacklinks.map((backlink) => (
                <li key={`${backlink.source_node_id}-${backlink.position}`} className="backlink-item">
                  <button
                    className="backlink-button"
                    onClick={() => onLinkClick?.(backlink.source_node_id, backlink.source_page_id, backlink.source_page_id === null)}
                  >
                    <span className="backlink-title">
                      {backlink.source_node_name || 'Untitled'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </NodeViewSection>
  );
}

/**
 * Inline breadcrumb component for linked references
 * Shows the path from page ancestor down to the source node's PARENT (excludes source node itself)
 */
interface ReferenceBreadcrumbProps {
  breadcrumbs: BreadcrumbSegment[];
  sourceNodeId: number; // ID of the source node to exclude from breadcrumbs
  sourcePage: { id: number; name: string; icon?: string | null } | null;
  onNavigate?: (nodeId: number) => void;
}

function ReferenceBreadcrumb({ breadcrumbs, sourceNodeId, sourcePage, onNavigate }: ReferenceBreadcrumbProps) {
  // Build display items from breadcrumbs, excluding the source node itself
  const items = useMemo(() => {
    if (breadcrumbs.length === 0 && sourcePage) {
      // Fallback: just show the page
      return [{
        id: sourcePage.id,
        name: sourcePage.name || 'Untitled',
        icon: sourcePage.icon,
        isProperty: false,
      }];
    }
    
    // Breadcrumbs come from the service as [source, parent, ..., page] order
    // We want to display as [page, ..., parent] (excluding source node itself)
    // Filter out the source node, then reverse to show page first
    const withoutSource = breadcrumbs.filter(seg => seg.node_id !== sourceNodeId);
    const reversed = [...withoutSource].reverse();
    return reversed.map(seg => ({
      id: seg.node_id,
      name: seg.name,
      icon: null as string | null,
      isProperty: seg.is_property,
    }));
  }, [breadcrumbs, sourceNodeId, sourcePage]);

  if (items.length === 0) return null;

  return (
    <div className="ref-breadcrumb">
      {items.map((item, idx) => (
        <span key={item.isProperty ? `prop-${idx}` : item.id ?? idx} className="ref-breadcrumb-item">
          {item.id !== null && !item.isProperty ? (
            <button
              className="ref-breadcrumb-link"
              onClick={(e) => {
                e.stopPropagation();
                if (item.id !== null) onNavigate?.(item.id);
              }}
            >
              <span className="ref-breadcrumb-name">{item.name}</span>
            </button>
          ) : (
            <span className={`ref-breadcrumb-text ${item.isProperty ? 'ref-breadcrumb-property' : ''}`}>
              {item.isProperty ? `#${item.name}` : item.name}
            </span>
          )}
          {idx < items.length - 1 && (
            <span className="ref-breadcrumb-separator">/</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Single linked reference entry with breadcrumb and real Block component
 * 
 * Displays a breadcrumb path followed by a fully functional Block element
 * (editable, with bullet, drag handle, context menu, etc.)
 */
interface LinkedReferenceEntryProps {
  reference: LinkedReference;
  onNavigate?: (nodeId: number, pageId?: number | null) => void;
}

function _LinkedReferenceEntry({ reference, onNavigate }: LinkedReferenceEntryProps) {
  const updateNode = useUpdateNode();
  
  // Convert LinkedReference source_node to Node format
  const sourceNode: Node = useMemo(() => {
    return {
      id: reference.source_node.id,
      uuid: '',
      name: reference.source_node.name || '',
      icon: reference.source_node.icon || null,
      color: null,
      is_page: false,
      parent_id: null,
      page_id: null,
      sequence: 0,
      active: true,
      create_date: '',
      write_date: '',
      types: [],
      tags: [],
      collapsed: false,
      children: [],
    };
  }, [reference.source_node]);
  
  const handleBreadcrumbNavigate = (nodeId: number) => {
    onNavigate?.(nodeId);
  };
  
  const handleContentChange = useCallback((blockId: number, content: string) => {
    updateNode.mutate({ id: blockId, data: { name: content } });
  }, [updateNode]);

  return (
    <div className="linked-ref-entry">
      <ReferenceBreadcrumb
        breadcrumbs={reference.breadcrumb_path || []}
        sourceNodeId={reference.source_node.id}
        sourcePage={reference.source_page}
        onNavigate={handleBreadcrumbNavigate}
      />
      <div className="linked-ref-block-wrapper">
        <Block
          block={sourceNode}
          parentId={null}
          onContentChange={handleContentChange}
          onBulletClick={() => onNavigate?.(sourceNode.id, reference.source_page?.id)}
        />
      </div>
    </div>
  );
}

/**
 * Linked references section with surrounding context
 * 
 * Shows where this node is mentioned with breadcrumbs and real Block elements.
 * The entire section is collapsible via NodeViewSection.
 * Supports multiple view modes via SelectionSwitch (list, table, card).
 */
export function LinkedReferences({
  nodeId,
  className = '',
  onLinkClick,
}: BacklinksProps) {
  const { data: refs, isLoading: refsLoading } = useLinkedReferences(nodeId);
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(nodeId);

  const isLoading = refsLoading || propLoading;

  // Convert property backlinks to PageReferenceItem format for the pages section
  const pageItems: PageReferenceItem[] = useMemo(() => {
    if (!propertyBacklinks) return [];
    return propertyBacklinks.map(propertyBacklinkToPageItem);
  }, [propertyBacklinks]);

  // Convert to NodeSetItem format for NodeSet component
  const nodeSetItems: NodeSetItem[] = useMemo(() => {
    const items: NodeSetItem[] = [];
    
    // Add pages (from property backlinks)
    for (const pageItem of pageItems) {
      items.push({
        node: {
          id: pageItem.sourcePage.id,
          uuid: '',
          name: pageItem.sourcePage.name || 'Untitled',
          icon: pageItem.sourcePage.icon || null,
          color: null,
          is_page: true,
          parent_id: null,
          page_id: null,
          sequence: 0,
          active: true,
          create_date: '',
          write_date: '',
          types: [],
          tags: [],
          collapsed: false,
          children: [],
        },
        context: `via ${pageItem.propertyName}`,
      });
    }
    
    // Add blocks (from linked references)
    if (refs) {
      for (const ref of refs) {
        items.push({
          node: {
            id: ref.source_node.id,
            uuid: '',
            name: ref.source_node.name || 'Untitled',
            icon: ref.source_node.icon || null,
            color: null,
            is_page: false,
            parent_id: null,
            page_id: ref.source_page?.id ?? null,
            sequence: 0,
            active: true,
            create_date: '',
            write_date: '',
            types: [],
            tags: [],
            collapsed: false,
            children: [],
          },
          page: ref.source_page ? {
            id: ref.source_page.id,
            uuid: '',
            name: ref.source_page.name || 'Untitled',
            icon: ref.source_page.icon || null,
            color: null,
            is_page: true,
            parent_id: null,
            page_id: null,
            sequence: 0,
            active: true,
            create_date: '',
            write_date: '',
            types: [],
            tags: [],
            collapsed: false,
            children: [],
          } : null,
        });
      }
    }
    
    return items;
  }, [pageItems, refs]);

  // Build page map for NodeSet
  const pageMap = useMemo(() => {
    const map = new Map<number, Node>();
    if (refs) {
      for (const ref of refs) {
        if (ref.source_page && !map.has(ref.source_page.id)) {
          map.set(ref.source_page.id, {
            id: ref.source_page.id,
            uuid: '',
            name: ref.source_page.name || 'Untitled',
            icon: ref.source_page.icon || null,
            color: null,
            is_page: true,
            parent_id: null,
            page_id: null,
            sequence: 0,
            active: true,
            create_date: '',
            write_date: '',
            types: [],
            tags: [],
            collapsed: false,
            children: [],
          });
        }
      }
    }
    return map;
  }, [refs]);

  const handleNodeClick = useCallback((node: Node) => {
    onLinkClick?.(node.id, node.page_id, node.is_page);
  }, [onLinkClick]);

  if (isLoading) {
    return (
      <div className={`linked-references loading ${className}`}>
        <div className="linked-references-skeleton">Loading references...</div>
      </div>
    );
  }

  const blockCount = refs?.length ?? 0;
  const totalCount = blockCount + pageItems.length;
  
  if (totalCount === 0) {
    return null;
  }

  return (
    <NodeViewSection
      title="Linked References"
      icon={<LinkIcon size="sm" />}
      count={totalCount}
      className={className}
      defaultExpanded={true}
    >
      <NodeSet
        items={nodeSetItems}
        showHeader={true}
        showViewToggle={true}
        onNodeClick={handleNodeClick}
        defaultViewType="list"
        viewTypes={['list', 'table', 'card']}
        defaultGroupBy="page"
        groupByOptions={['none', 'page']}
        showGroupBySettings={true}
        pageMap={pageMap}
      />
    </NodeViewSection>
  );
}

/**
 * Combined component showing both backlinks and linked references
 * 
 * Uses the new ReferencesView with:
 * - Pages section: References from date/node properties
 * - Blocks section: References from [[links]] and ((refs)) in content
 */
export function References({
  nodeId,
  className = '',
  onLinkClick,
}: BacklinksProps) {
  return (
    <div className={`references ${className}`}>
      <LinkedReferences nodeId={nodeId} onLinkClick={onLinkClick} />
    </div>
  );
}

export default Backlinks;
