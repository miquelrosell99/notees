/**
 * PageHeader Component
 * 
 * Displays the page header with:
 * - Icon selector (emoji picker)
 * - Page title (editable)
 * - Type/tag chips
 * 
 * Banner image is rendered separately in NodeView before the header section.
 * Cover image is rendered separately in NodeView alongside the header.
 * Archive button and color picker have been moved to the NodeContextMenu.
 * Local graph button has been moved to the main header bar.
 */
import { useState, useRef, useCallback, useMemo } from 'react';
import { useUpdateNode, useTypes, useRemoveType, useNodes } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import type { Node, NodeUpdate } from '@/types';
import { NodeIcon, TagIcon } from './icons';
import { NodeTypePill } from './NodeTypePill';
import { EmojiPicker } from './core/EmojiPicker';
import { isSystemPage } from '../utils/systemPages';
import { SYSTEM_TYPE_UUIDS } from '@/constants';
import './PageHeader.css';

interface PageHeaderProps {
  /** The page node to display */
  page: Node;
  /** Whether clicking the title navigates instead of editing (compact mode) */
  compactMode?: boolean;
  /** Callback when right-clicking the header (for context menu) */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Callback when navigating to a type or tag */
  onNavigateToNode?: (nodeId: number) => void;
}

export function PageHeader({ 
  page, 
  compactMode = false, 
  onContextMenu,
  onNavigateToNode 
}: PageHeaderProps) {
  const iconRef = useRef<HTMLButtonElement>(null);
  const updateNode = useUpdateNode();
  const removeType = useRemoveType();
  const { 
    addSidebarCard, 
    openNode,
  } = useNodesStore();
  
  // Icon picker state
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [iconPickerPos, setIconPickerPos] = useState({ x: 0, y: 0 });
  
  // Get all types
  const { data: allTypes } = useTypes();
  const { data: allNodes } = useNodes({ pages_only: true });  // For fallback type lookup
  
  // Resolve type details from IDs (excluding the "page" type which is implicit)
  // Use allNodes as fallback for system types that might not be in allTypes
  const pageTypeDetails = useMemo(() => {
    if (!page.types || page.types.length === 0) return [];
    return page.types
      .map(typeId => {
        // First try allTypes, then fallback to allNodes
        const fromTypes = allTypes?.find(t => t.id === typeId);
        if (fromTypes) return fromTypes;
        return allNodes?.find(n => n.id === typeId);
      })
      .filter((t): t is Node => t !== undefined && t.uuid !== SYSTEM_TYPE_UUIDS.page);
  }, [page.types, allTypes, allNodes]);
  
  // Get effective icon (page's icon or first type's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(page, allTypes), [page, allTypes]);
  
  // Check if page name is editable
  const isNameEditable = !isSystemPage(page);

  const handleNameChange = useCallback((newName: string) => {
    const data: NodeUpdate = { name: newName };
    updateNode.mutate({ id: page.id, data });
  }, [page.id, updateNode]);

  // Handle icon change via emoji picker
  const handleIconClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      setIconPickerPos({
        x: Math.min(rect.left, window.innerWidth - 320),
        y: Math.min(rect.bottom + 4, window.innerHeight - 400),
      });
    }
    setShowIconPicker(true);
  }, []);

  const handleIconSelect = useCallback((icon: string) => {
    const data: NodeUpdate = { icon: icon || null };
    updateNode.mutate({ id: page.id, data });
    setShowIconPicker(false);
  }, [page.id, updateNode]);

  // Handle Ctrl+C on page title to copy page link when nothing is selected
  const handlePageTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const input = e.currentTarget;
      const hasSelection = input.selectionStart !== input.selectionEnd;
      if (!hasSelection && page.name) {
        e.preventDefault();
        const pageLink = `[[${page.name}]]`;
        navigator.clipboard.writeText(pageLink);
      }
    }
  }, [page.name]);

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      addSidebarCard(page.id, 'page');
    }
  }, [page.id, addSidebarCard]);

  const handleNavigateToNode = useCallback((nodeId: number) => {
    if (onNavigateToNode) {
      onNavigateToNode(nodeId);
    } else {
      openNode(nodeId, 'page');
    }
  }, [onNavigateToNode, openNode]);

  return (
    <>
      <header 
        className="page-header" 
        onClick={handleHeaderClick} 
        onContextMenu={onContextMenu}
      >
        {/* Title row: Icon + Title */}
        <div className="page-header__title-row">
          <button
            ref={iconRef}
            className="page-icon-btn"
            onClick={handleIconClick}
            title="Change icon"
          >
            {effectiveIcon || page.is_daily || page.is_monthly || page.is_yearly ? (
              <NodeIcon 
                icon={effectiveIcon} 
                isPage={true} 
                isDaily={page.is_daily}
                isMonthly={page.is_monthly}
                isYearly={page.is_yearly}
                size="xl" 
                className="page-icon-large" 
              />
            ) : (
              <span className="page-icon-placeholder">+</span>
            )}
          </button>
          
          <div className="page-title-container">
            {compactMode ? (
              <h1
                className="page-title-input page-title-clickable"
                onClick={(e) => { e.stopPropagation(); openNode(page.id, 'page'); }}
                title="Click to open page"
              >
                {page.name || 'Untitled'}
              </h1>
            ) : (
              <input
                type="text"
                className={`page-title-input${!isNameEditable ? ' readonly' : ''}`}
                value={page.name || ''}
                onChange={(e) => handleNameChange(e.target.value)}
                onKeyDown={handlePageTitleKeyDown}
                placeholder="Untitled"
                onClick={(e) => e.stopPropagation()}
                readOnly={!isNameEditable}
                title={!isNameEditable ? 'System page names cannot be edited' : undefined}
              />
            )}
            {page.active === false && (
              <span className="archived-badge">Archived</span>
            )}
          </div>
        </div>
        
        {/* Properties row: Types and Tags */}
        {(pageTypeDetails.length > 0) || (page.tags && page.tags.length > 0) ? (
          <div className="page-header__properties">
            {pageTypeDetails.length > 0 && (
              <div className="node-types">
                {pageTypeDetails.map((typeNode) => (
                  <NodeTypePill
                    key={typeNode.id}
                    typeNode={typeNode}
                    onClick={() => handleNavigateToNode(typeNode.id)}
                    onRemove={() => removeType.mutate({ nodeId: page.id, typeId: typeNode.id })}
                  />
                ))}
              </div>
            )}
            {page.tags && page.tags.length > 0 && (
              <div className="node-tags">
                {page.tags.map((tagId) => (
                  <button
                    key={tagId}
                    className="node-tag-chip"
                    onClick={() => handleNavigateToNode(tagId)}
                    title="Click to view tag page"
                  >
                    <TagIcon size="xs" />
                    <span>Tag #{tagId}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </header>
      
      {/* Icon Picker */}
      {showIconPicker && (
        <EmojiPicker
          value={page.icon || ''}
          onSelect={handleIconSelect}
          onClose={() => setShowIconPicker(false)}
          position={iconPickerPos}
        />
      )}
    </>
  );
}

export default PageHeader;
