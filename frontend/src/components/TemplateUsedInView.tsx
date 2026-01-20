/**
 * TemplateUsedInView - Component for showing where a template has been used
 * 
 * Templates have a special "used in" property that tracks which blocks
 * were created using the template. This view displays those blocks.
 */
import { useMemo } from 'react';
import { useNodes } from '@/hooks';
import type { Node } from '@/types/api';
import { NodeIcon, BulletIcon } from './icons';
import { Button } from './core/Button';

interface TemplateUsedInViewProps {
  /** The template node */
  templateNode: Node;
  /** Node IDs that reference this template (from used_in property) */
  usedInNodeIds: number[];
  /** Callback when a node is clicked */
  onNavigate?: (nodeId: number) => void;
  /** Callback when a node is shift-clicked to open in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
}

interface UsedInItem {
  node: Node;
  page: Node | null;
  isPage: boolean;
}

/**
 * TemplateUsedInView Component
 */
export function TemplateUsedInView({
  templateNode: _templateNode,
  usedInNodeIds,
  onNavigate,
  onOpenInSidebar,
}: TemplateUsedInViewProps) {
  const { data: allNodes } = useNodes();
  
  // Resolve node IDs to actual nodes with page context
  const usedInItems = useMemo((): UsedInItem[] => {
    if (!allNodes || usedInNodeIds.length === 0) return [];
    
    const items: UsedInItem[] = [];
    
    for (const nodeId of usedInNodeIds) {
      const node = allNodes.find(n => n.id === nodeId);
      if (!node) continue;
      
      const isPage = node.parent_id === null;
      let page: Node | null = null;
      
      // Find the parent page for blocks
      if (!isPage && node.page_id) {
        page = allNodes.find(n => n.id === node.page_id) ?? null;
      }
      
      items.push({ node, page, isPage });
    }
    
    return items;
  }, [allNodes, usedInNodeIds]);
  
  // Group by page for better organization
  const groupedItems = useMemo(() => {
    const groups = new Map<number | null, UsedInItem[]>();
    
    for (const item of usedInItems) {
      const pageId = item.isPage ? item.node.id : item.page?.id ?? null;
      const existing = groups.get(pageId) ?? [];
      existing.push(item);
      groups.set(pageId, existing);
    }
    
    return groups;
  }, [usedInItems]);
  
  const handleClick = (nodeId: number, e: React.MouseEvent) => {
    if (e.shiftKey) {
      onOpenInSidebar?.(nodeId);
    } else {
      onNavigate?.(nodeId);
    }
  };
  
  if (usedInNodeIds.length === 0) {
    return (
      <div className="template-used-in template-used-in--empty">
        <p className="template-used-in__empty-text">
          This template hasn't been used yet.
        </p>
        <p className="template-used-in__hint">
          Use this template by typing its name when creating a new block.
        </p>
      </div>
    );
  }
  
  return (
    <div className="template-used-in">
      <header className="template-used-in__header">
        <h3 className="template-used-in__title">
          Used in {usedInNodeIds.length} {usedInNodeIds.length === 1 ? 'place' : 'places'}
        </h3>
      </header>
      
      <div className="template-used-in__list">
        {Array.from(groupedItems.entries()).map(([pageId, items]) => {
          const firstItem = items[0];
          const pageName = firstItem.isPage 
            ? (firstItem.node.name || 'Untitled Page')
            : (firstItem.page?.name || 'Unknown Page');
          
          return (
            <div key={pageId ?? 'no-page'} className="template-used-in__group">
              {/* Page header */}
              <Button
                className="template-used-in__page-header"
                variant="ghost"
                size="sm"
                onClick={(e) => handleClick(pageId ?? items[0].node.id, e)}
              >
                <NodeIcon 
                  icon={firstItem.isPage ? firstItem.node.icon : firstItem.page?.icon} 
                  isPage={true} 
                  size="sm" 
                />
                <span className="template-used-in__page-name">{pageName}</span>
              </Button>
              
              {/* Blocks within this page */}
              {items.map((item) => (
                <Button
                  key={item.node.id}
                  className="template-used-in__item"
                  variant="ghost"
                  size="sm"
                  onClick={(e) => handleClick(item.node.id, e)}
                  title="Click to navigate, Shift+click to open in sidebar"
                >
                  <span className="template-used-in__item-icon">
                    {item.isPage ? (
                      <NodeIcon icon={item.node.icon} isPage={true} size="xs" />
                    ) : (
                      <BulletIcon size="xs" />
                    )}
                  </span>
                  <span className="template-used-in__item-content">
                    {item.node.name || 'Untitled'}
                  </span>
                </Button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TemplateUsedInView;
