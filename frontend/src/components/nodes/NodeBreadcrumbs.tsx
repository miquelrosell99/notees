/**
 * NodeBreadcrumbs Component
 * 
 * Displays a breadcrumb navigation for nodes (pages and blocks).
 * - For pages: Shows parent hierarchy, only visible if page has a parent
 * - For blocks: Shows path from page through parent blocks to current block
 * - For blocks from text properties: Shows page > property name path
 */
import { useMemo } from 'react';
import { useNode } from '@/hooks';
import { NodeIcon, ChevronRightIcon } from '../icons';
import { Button } from '../core/Button';
import './NodeBreadcrumbs.css';

export interface BreadcrumbItem {
  id: number;
  name: string;
  icon?: string | null;
  isPage: boolean;
  /** If this is a property breadcrumb item */
  isProperty?: boolean;
  /** Property ID for property items */
  propertyId?: number;
}

interface NodeBreadcrumbsProps {
  /** The node to show breadcrumbs for */
  nodeId: number;
  /** Type of node (affects how breadcrumbs are built) */
  nodeType: 'page' | 'block';
  /** Callback when clicking a breadcrumb item */
  onNavigate?: (nodeId: number, nodeType: 'page' | 'block') => void;
  /** Callback when clicking a property breadcrumb item */
  onNavigateToProperty?: (propertyId: number) => void;
  /** Property context for when viewing a block from a text property */
  propertyContext?: { propertyId: number; propertyName: string } | null;
  /** Additional CSS class */
  className?: string;
}
/**
 * Hook to build breadcrumb items for a page (parent hierarchy)
 */
function usePageBreadcrumbs(pageId: number): BreadcrumbItem[] {
  const { data: page } = useNode(pageId);
  const { data: parentPage } = useNode(page?.parent_id ?? null);
  const { data: grandParentPage } = useNode(parentPage?.parent_id ?? null);
  const { data: greatGrandParentPage } = useNode(grandParentPage?.parent_id ?? null);
  
  return useMemo((): BreadcrumbItem[] => {
    const items: BreadcrumbItem[] = [];
    
    // Build from furthest ancestor to immediate parent
    if (greatGrandParentPage) {
      items.push({
        id: greatGrandParentPage.id,
        name: greatGrandParentPage.name || 'Untitled',
        icon: greatGrandParentPage.icon,
        isPage: true,
      });
    }
    
    if (grandParentPage) {
      items.push({
        id: grandParentPage.id,
        name: grandParentPage.name || 'Untitled',
        icon: grandParentPage.icon,
        isPage: true,
      });
    }
    
    if (parentPage) {
      items.push({
        id: parentPage.id,
        name: parentPage.name || 'Untitled',
        icon: parentPage.icon,
        isPage: true,
      });
    }
    
    return items;
  }, [parentPage, grandParentPage, greatGrandParentPage]);
}

/**
 * Hook to build breadcrumb items for a block (page + parent blocks)
 */
function useBlockBreadcrumbs(blockId: number): BreadcrumbItem[] {
  const { data: block } = useNode(blockId);
  const { data: parentNode } = useNode(block?.parent_id ?? null);
  const { data: pageNode } = useNode(block?.page_id ?? null);
  
  return useMemo((): BreadcrumbItem[] => {
    if (!block) return [];
    
    const items: BreadcrumbItem[] = [];
    
    // Start with the page (root of our breadcrumb)
    if (pageNode) {
      items.push({
        id: pageNode.id,
        name: pageNode.name || 'Untitled',
        icon: pageNode.icon,
        isPage: true
      });
    }
    
    // If the parent is not the page, add the parent block
    if (parentNode && parentNode.id !== pageNode?.id) {
      items.push({
        id: parentNode.id,
        name: parentNode.name || 'Untitled',
        icon: parentNode.icon,
        isPage: false
      });
    }
    
    return items;
  }, [block, pageNode, parentNode]);
}

export function NodeBreadcrumbs({ 
  nodeId, 
  nodeType, 
  onNavigate,
  onNavigateToProperty,
  propertyContext,
  className = '' 
}: NodeBreadcrumbsProps) {
  // Build breadcrumbs based on node type
  const pageBreadcrumbs = usePageBreadcrumbs(nodeType === 'page' ? nodeId : 0);
  const blockBreadcrumbs = useBlockBreadcrumbs(nodeType === 'block' ? nodeId : 0);
  
  // Build final breadcrumbs including property context if present
  const breadcrumbs = useMemo(() => {
    const baseBreadcrumbs = nodeType === 'page' ? pageBreadcrumbs : blockBreadcrumbs;
    
    // If we have property context, insert the property after the page
    if (propertyContext && nodeType === 'block' && baseBreadcrumbs.length > 0) {
      const result: BreadcrumbItem[] = [];
      
      // Add the page first (if present)
      if (baseBreadcrumbs[0]?.isPage) {
        result.push(baseBreadcrumbs[0]);
      }
      
      // Add the property
      result.push({
        id: propertyContext.propertyId,
        name: propertyContext.propertyName,
        icon: null,
        isPage: false,
        isProperty: true,
        propertyId: propertyContext.propertyId,
      });
      
      // Add remaining breadcrumbs (parent blocks if any, excluding the page we already added)
      for (let i = 1; i < baseBreadcrumbs.length; i++) {
        result.push(baseBreadcrumbs[i]);
      }
      
      return result;
    }
    
    return baseBreadcrumbs;
  }, [nodeType, pageBreadcrumbs, blockBreadcrumbs, propertyContext]);
  
  // For pages, only show breadcrumbs if there's a parent
  if (nodeType === 'page' && breadcrumbs.length === 0) {
    return null;
  }
  
  // For blocks, always show at least the page
  if (nodeType === 'block' && breadcrumbs.length === 0) {
    return null;
  }
  
  const handleClick = (item: BreadcrumbItem) => {
    if (item.isProperty && item.propertyId) {
      onNavigateToProperty?.(item.propertyId);
    } else {
      onNavigate?.(item.id, item.isPage ? 'page' : 'block');
    }
  };

  return (
    <nav 
      className={`node-breadcrumbs ${className}`} 
      aria-label={nodeType === 'page' ? 'Page hierarchy' : 'Block path'}
    >
      {breadcrumbs.map((item, index) => (
        <span key={item.isProperty ? `prop-${item.id}` : item.id} className="node-breadcrumb-item">
          <Button 
            variant="ghost"
            size="xs"
            className={`node-breadcrumb-link ${item.isProperty ? 'node-breadcrumb-property' : ''}`}
            onClick={() => handleClick(item)}
            title={item.isProperty ? `View property: ${item.name}` : `Go to ${item.name}`}
          >
            {item.isPage ? (
              <NodeIcon icon={item.icon} isPage={true} size="xs" />
            ) : item.isProperty ? (
              <span className="node-breadcrumb-property-icon">⚙</span>
            ) : (
              <span className="node-breadcrumb-bullet">•</span>
            )}
            <span className="node-breadcrumb-name">{item.name}</span>
          </Button>
          {index < breadcrumbs.length - 1 && (
            <ChevronRightIcon size="xs" className="node-breadcrumb-separator" />
          )}
        </span>
      ))}
    </nav>
  );
}

export default NodeBreadcrumbs;
