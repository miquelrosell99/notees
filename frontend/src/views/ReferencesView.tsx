/**
 * ReferencesView - Reusable components for displaying linked references
 * 
 * Provides two view types:
 * 1. LinkedReferencesList - Blocks grouped by page (Logseq-style)
 * 2. LinkedReferencesTable - Table view with blocks as rows
 * 
 * These are general-purpose components used by:
 * - Backlinks section on pages
 * - Tagged nodes view
 * - Query results view
 */
import { useState, useMemo } from 'react';
import './ReferencesView.css';
import type { Node, LinkedReference, PropertyBacklink } from '@/types/api';
import { BulletIcon, LinkIcon, NodeIcon } from '../components/icons';
import { Button } from '../components/core/Button';

// ==================== Types ====================

export type ReferenceViewMode = 'list' | 'table';

export interface ReferenceItem {
  /** The node (block) that contains the reference */
  sourceNode: Node;
  /** The page the block belongs to (null if orphan or is a page itself) */
  sourcePage: Node | null;
  /** Type of link: 'page' for [[links]], 'block' for ((refs)) */
  linkType: 'page' | 'block' | 'property';
  /** Surrounding context text */
  context?: string;
  /** Property info if this is a property backlink */
  propertyName?: string;
}

export interface PageReferenceItem {
  /** The page that references via property */
  sourcePage: Node;
  /** Name of the property that contains the reference */
  propertyName: string;
  /** Property ID */
  propertyId: number;
}

export interface ReferencesViewProps {
  /** Reference items to display */
  items: ReferenceItem[];
  /** Page reference items (from properties) - optional */
  pageItems?: PageReferenceItem[];
  /** Current view mode */
  viewMode?: ReferenceViewMode;
  /** Called when clicking a reference */
  onItemClick?: (nodeId: number, pageId?: number | null) => void;
  /** Whether to show the view mode toggle */
  showViewToggle?: boolean;
  /** Title for the section */
  title?: string;
  /** Extra CSS class */
  className?: string;
  /** Whether to show empty state */
  showEmpty?: boolean;
  /** Empty state message */
  emptyMessage?: string;
}

// ==================== Utility Functions ====================

/**
 * Group reference items by source page
 */
function groupByPage(items: ReferenceItem[]): Map<number | null, ReferenceItem[]> {
  const groups = new Map<number | null, ReferenceItem[]>();
  
  for (const item of items) {
    const pageId = item.sourcePage?.id ?? null;
    const existing = groups.get(pageId) ?? [];
    existing.push(item);
    groups.set(pageId, existing);
  }
  
  return groups;
}

// ==================== View Mode Toggle ====================

interface ViewModeToggleProps {
  mode: ReferenceViewMode;
  onChange: (mode: ReferenceViewMode) => void;
}

function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  return (
    <div className="ref-view-toggle">
      <Button
        variant={mode === 'list' ? 'default' : 'ghost'}
        size="xs"
        active={mode === 'list'}
        onClick={() => onChange('list')}
        title="List view"
      >
        =
      </Button>
      <Button
        variant={mode === 'table' ? 'default' : 'ghost'}
        size="xs"
        active={mode === 'table'}
        onClick={() => onChange('table')}
        title="Table view"
      >
        #
      </Button>
    </div>
  );
}

// ==================== Page References Section ====================

interface PageReferencesSectionProps {
  items: PageReferenceItem[];
  onPageClick?: (pageId: number) => void;
}

/**
 * Section showing pages that reference via properties
 * These apply to the whole page, not specific blocks
 */
function PageReferencesSection({ items, onPageClick }: PageReferencesSectionProps) {
  if (items.length === 0) return null;
  
  // Group by property name
  const byProperty = new Map<string, PageReferenceItem[]>();
  for (const item of items) {
    const existing = byProperty.get(item.propertyName) ?? [];
    existing.push(item);
    byProperty.set(item.propertyName, existing);
  }
  
  return (
    <div className="ref-pages-section">
      <h4 className="ref-pages-section-title">
        <span className="ref-pages-icon"></span>
        Pages ({items.length})
      </h4>
      <p className="ref-pages-description">
        Pages linking here via properties
      </p>
      <div className="ref-pages-list">
        {items.map((item, idx) => (
          <Button
            key={`${item.sourcePage.id}-${item.propertyId}-${idx}`}
            className="ref-page-item"
            variant="ghost"
            size="sm"
            onClick={() => onPageClick?.(item.sourcePage.id)}
          >
            <NodeIcon 
              icon={item.sourcePage.icon} 
              isPage={true} 
              size="sm" 
            />
            <span className="ref-page-name">
              {item.sourcePage.name || 'Untitled'}
            </span>
            <span className="ref-page-property">
              via {item.propertyName}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

// ==================== List View ====================

interface LinkedReferencesListProps {
  items: ReferenceItem[];
  onItemClick?: (nodeId: number, pageId?: number | null) => void;
}

/**
 * Logseq-style list view: blocks grouped by page
 */
export function LinkedReferencesList({ items, onItemClick }: LinkedReferencesListProps) {
  const grouped = useMemo(() => groupByPage(items), [items]);
  
  if (items.length === 0) return null;
  
  return (
    <div className="ref-list">
      {Array.from(grouped.entries()).map(([pageId, pageItems]) => (
        <div key={pageId ?? 'orphan'} className="ref-list-group">
          {/* Page header */}
          {pageItems[0].sourcePage && (
            <Button
              className="ref-list-page-header"
              variant="ghost"
              size="sm"
              onClick={() => pageId && onItemClick?.(pageId)}
            >
              <NodeIcon 
                icon={pageItems[0].sourcePage.icon} 
                isPage={true} 
                size="sm" 
              />
              <span className="ref-list-page-name">
                {pageItems[0].sourcePage.name || 'Untitled'}
              </span>
            </Button>
          )}
          
          {/* Blocks under this page */}
          <ul className="ref-list-blocks">
            {pageItems.map((item, idx) => (
              <li key={`${item.sourceNode.id}-${idx}`} className="ref-list-block">
                <Button
                  className="ref-list-block-btn"
                  variant="ghost"
                  size="sm"
                  onClick={() => onItemClick?.(item.sourceNode.id, item.sourcePage?.id)}
                >
                  <span className="ref-list-bullet">
                    <BulletIcon size="xs" />
                  </span>
                  <span className="ref-list-block-content">
                    {item.context || item.sourceNode.name || 'Untitled'}
                  </span>
                  <span className="ref-list-type-badge" data-type={item.linkType}>
                    {item.linkType}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ==================== Table View ====================

interface LinkedReferencesTableProps {
  items: ReferenceItem[];
  onItemClick?: (nodeId: number, pageId?: number | null) => void;
}

/**
 * Table view: each block as a row
 */
export function LinkedReferencesTable({ items, onItemClick }: LinkedReferencesTableProps) {
  if (items.length === 0) return null;
  
  return (
    <div className="ref-table-container">
      <table className="ref-table">
        <thead>
          <tr>
            <th className="ref-table-th">Block</th>
            <th className="ref-table-th">Page</th>
            <th className="ref-table-th">Type</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr 
              key={`${item.sourceNode.id}-${idx}`} 
              className="ref-table-row"
              onClick={() => onItemClick?.(item.sourceNode.id, item.sourcePage?.id)}
            >
              <td className="ref-table-td ref-table-block">
                <span className="ref-table-bullet">
                  <BulletIcon size="xs" />
                </span>
                <span className="ref-table-block-text">
                  {item.context || item.sourceNode.name || 'Untitled'}
                </span>
              </td>
              <td className="ref-table-td ref-table-page">
                {item.sourcePage ? (
                  <span className="ref-table-page-name">
                    <NodeIcon 
                      icon={item.sourcePage.icon} 
                      isPage={true} 
                      size="xs" 
                    />
                    {item.sourcePage.name || 'Untitled'}
                  </span>
                ) : (
                  <span className="ref-table-no-page">—</span>
                )}
              </td>
              <td className="ref-table-td">
                <span className="ref-table-type-badge" data-type={item.linkType}>
                  {item.linkType}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ==================== Combined References View ====================

/**
 * Full references view with toggle between list and table
 * Includes both page references (from properties) and block references (from content)
 */
export function ReferencesView({
  items,
  pageItems = [],
  viewMode: initialViewMode = 'list',
  onItemClick,
  showViewToggle = true,
  title = 'Linked References',
  className = '',
  showEmpty = false,
  emptyMessage = 'No references found',
}: ReferencesViewProps) {
  const [viewMode, setViewMode] = useState<ReferenceViewMode>(initialViewMode);
  
  const totalCount = items.length + pageItems.length;
  
  if (totalCount === 0) {
    if (!showEmpty) return null;
    return (
      <div className={`references-view references-view--empty ${className}`}>
        <p className="references-empty">{emptyMessage}</p>
      </div>
    );
  }
  
  return (
    <section className={`references-view ${className}`}>
      <div className="references-header">
        <h3 className="references-title">
          <span className="references-icon"><LinkIcon size="sm" /></span>
          {title} ({totalCount})
        </h3>
        {showViewToggle && items.length > 0 && (
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        )}
      </div>
      
      {/* Page references section (from properties) */}
      {pageItems.length > 0 && (
        <PageReferencesSection 
          items={pageItems}
          onPageClick={(pageId) => onItemClick?.(pageId)}
        />
      )}
      
      {/* Block references section */}
      {items.length > 0 && (
        <div className="ref-blocks-section">
          {pageItems.length > 0 && (
            <h4 className="ref-blocks-section-title">
              <span className="ref-blocks-icon"><BulletIcon size="xs" /></span>
              Blocks ({items.length})
            </h4>
          )}
          
          {viewMode === 'list' ? (
            <LinkedReferencesList items={items} onItemClick={onItemClick} />
          ) : (
            <LinkedReferencesTable items={items} onItemClick={onItemClick} />
          )}
        </div>
      )}
    </section>
  );
}

// ==================== Conversion Helpers ====================

/**
 * Convert LinkedReference API response to ReferenceItem
 */
export function linkedReferenceToItem(ref: LinkedReference): ReferenceItem {
  return {
    sourceNode: ref.source_node,
    sourcePage: ref.source_page,
    linkType: ref.link_type as 'page' | 'block',
    context: ref.context,
  };
}

/**
 * Convert PropertyBacklink API response to PageReferenceItem
 */
export function propertyBacklinkToPageItem(backlink: PropertyBacklink): PageReferenceItem {
  return {
    sourcePage: backlink.source_page,
    propertyName: backlink.property_name,
    propertyId: backlink.property_id,
  };
}

export default ReferencesView;
