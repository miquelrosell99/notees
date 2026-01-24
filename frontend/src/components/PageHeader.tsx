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
import { useUpdateNode, useClasses } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import type { Node, NodeUpdate } from '@/types';
import { NodeIcon } from './icons';
import { EmojiPicker } from './core/EmojiPicker';
import { isSystemPage } from '../utils/systemPages';
import './PageHeader.css';

interface PageHeaderProps {
  /** The page node to display */
  page: Node;
  /** Whether clicking the title navigates instead of editing (compact mode) */
  compactMode?: boolean;
  /** Callback when right-clicking the header (for context menu) */
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function PageHeader({ 
  page, 
  compactMode = false, 
  onContextMenu,
}: PageHeaderProps) {
  const iconRef = useRef<HTMLButtonElement>(null);
  const updateNode = useUpdateNode();
  const { 
    addSidebarCard, 
    openNode,
  } = useNodesStore();
  
  // Icon picker state
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [iconPickerPos, setIconPickerPos] = useState({ x: 0, y: 0 });
  
  // Get all classes (for effective icon calculation)
  const { data: allClasses } = useClasses();
  
  // Get effective icon (page's icon or first class's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(page, allClasses), [page, allClasses]);
  
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
