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
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useUpdateNode, useClasses, useCreateNode, usePageClass } from '@/hooks';
import { listNodes } from '@/api/nodes';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import type { Node, NodeUpdate } from '@/types';
import { NodeIcon } from './icons';
import { EmojiPicker } from './core/EmojiPicker';
import { isSystemPage } from '../utils/systemPages';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
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
  const createNode = useCreateNode();
  const { pageClassId } = usePageClass();
  const { 
    addSidebarCard, 
    openNode,
  } = useNodesStore();
  
  // Icon picker state
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [iconPickerPos, setIconPickerPos] = useState({ x: 0, y: 0 });
  
  // Local state for input value (to show preview before committing)
  const [inputValue, setInputValue] = useState(page.name || '');
  
  // Sync with page name when it changes externally
  useEffect(() => {
    setInputValue(page.name || '');
  }, [page.name]);
  
  // Get all classes (for effective icon calculation)
  const { data: allClasses } = useClasses();
  
  // Get effective icon (page's icon or first class's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(page, allClasses), [page, allClasses]);
  
  // Check if page name is editable
  const isNameEditable = !isSystemPage(page);
  
  // Parse input to show child page preview (disabled for date pages)
  const renamePreview = useMemo(() => {
    // Don't show preview for date pages
    if (page.is_daily || page.is_monthly || page.is_yearly) return null;
    
    if (!inputValue.includes('/')) return null;
    
    const parsed = parseHierarchicalPath(inputValue);
    const originalName = page.name || '';
    
    // Case 1: Creating child page (e.g., "Pokemon" → "Pokemon/Charizard" or "Pokemon/Gen1/Fire/Charizard")
    if (parsed.parentSegments.length > 0 && parsed.parentSegments[0] === originalName) {
      const childPath = [...parsed.parentSegments.slice(1), parsed.leaf].join('/');
      return { type: 'create-child' as const, path: childPath };
    }
    
    // Case 2: Moving to parent (e.g., "Charizard" → "Pokemon/Charizard" or "Types/Fire/Pokemon/Charizard")
    if (parsed.leaf === originalName && parsed.parentSegments.length > 0) {
      return { type: 'move-to-parent' as const, parent: parsed.parentSegments.join('/') };
    }
    
    // Case 3: Rename and move (e.g., "Charizard" → "Fire/Dragon" or "Types/Fire/Dragon")
    if (parsed.leaf !== originalName) {
      return { 
        type: 'rename-and-move' as const, 
        newName: parsed.leaf,
        parent: parsed.parentSegments.length > 0 ? parsed.parentSegments.join('/') : null
      };
    }
    
    return null;
  }, [inputValue, page.name, page.is_daily, page.is_monthly, page.is_yearly]);

  const handleInputChange = useCallback((newValue: string) => {
    setInputValue(newValue);
  }, []);

  const handleNameChange = useCallback(async (newName: string) => {
    // Disable hierarchical creation for date pages (daily, monthly, yearly)
    const isDatePage = page.is_daily || page.is_monthly || page.is_yearly;
    
    // Check if the new name contains "/" and this is not a date page
    if (newName.includes('/') && !isDatePage && pageClassId) {
      const parsed = parseHierarchicalPath(newName);
      const originalName = page.name || '';
      
      // Case 1: User keeps original name at start and adds "/" after it 
      // (e.g., "Pokemon" → "Pokemon/Charizard" or "Pokemon/Gen1/Fire/Charizard")
      // Create child pages under the current page
      if (parsed.parentSegments.length > 0 && parsed.parentSegments[0] === originalName) {
        try {
          // Fetch fresh pages from API to avoid stale cache issues
          const freshPages = await listNodes({ pages_only: true, include_children: true });
          // The child hierarchy starts after the original name
          const childSegments = parsed.parentSegments.slice(1);
          
          // Build lookup map for O(1) access
          const pageMap = new Map<string, Node>();
          for (const p of freshPages) {
            const key = `${p.name}|${p.parent_id ?? 'null'}`;
            pageMap.set(key, p);
          }
          
          // Resolve or create intermediate child pages
          let currentParent = page.id;
          for (const segment of childSegments) {
            const key = `${segment}|${currentParent}`;
            let node = pageMap.get(key);
            
            if (!node) {
              node = await createNode.mutateAsync({
                name: segment,
                classes: [pageClassId],
                parent_id: currentParent,
              });
              // Add to map so subsequent iterations can find it
              pageMap.set(key, node);
            }
            
            currentParent = node.id;
          }
          
          // Create the final leaf page
          if (parsed.leaf) {
            createNode.mutate({
              name: parsed.leaf,
              classes: [pageClassId],
              parent_id: currentParent,
            });
          }
          
          // Reset input to original name
          setInputValue(originalName);
          return;
        } catch (error) {
          console.error('Failed to create child hierarchy:', error);
          // Fall through to normal rename on error
        }
      }
      
      // Case 2: User adds something before the original name 
      // (e.g., "Charizard" → "Pokemon/Charizard" or "Types/Fire/Pokemon/Charizard")
      // Change the parent of the current page
      if (parsed.leaf === originalName && parsed.parentSegments.length > 0) {
        try {
          // Fetch fresh pages from API to avoid stale cache issues
          const freshPages = await listNodes({ pages_only: true, include_children: true });
          
          // Resolve or create parent pages (supports multiple levels)
          const parentId = await resolveHierarchicalParent(
            parsed.parentSegments,
            freshPages,
            async (name, parent) => {
              return await createNode.mutateAsync({
                name,
                parent_id: parent,
                classes: [pageClassId],
              });
            }
          );
          
          // Move current page under the new parent
          updateNode.mutate({ 
            id: page.id, 
            data: { parent_id: parentId } 
          });
          // Reset input to original name
          setInputValue(originalName);
          return;
        } catch (error) {
          console.error('Failed to resolve hierarchical parent:', error);
          // Fall through to normal rename on error
        }
      }
      
      // Case 3: Complete rename with hierarchy 
      // (e.g., "Charizard" → "Fire/Dragon" or "Types/Fire/Dragon/Charizard")
      // This is a different name entirely - update name and move to parent
      if (parsed.leaf !== originalName) {
        try {
          // Fetch fresh pages from API to avoid stale cache issues
          const freshPages = await listNodes({ pages_only: true, include_children: true });
          
          // Resolve or create parent pages (supports multiple levels)
          const parentId = await resolveHierarchicalParent(
            parsed.parentSegments,
            freshPages,
            async (name, parent) => {
              return await createNode.mutateAsync({
                name,
                parent_id: parent,
                classes: [pageClassId],
              });
            }
          );
          
          // Update page with new name and parent
          updateNode.mutate({ 
            id: page.id, 
            data: { 
              name: parsed.leaf,
              parent_id: parentId 
            } 
          });
          return;
        } catch (error) {
          console.error('Failed to resolve hierarchical parent:', error);
          // Fall through to normal rename on error
        }
      }
    }
    
    // Normal name change (no hierarchy, date pages, or fallback on error)
    const data: NodeUpdate = { name: newName };
    updateNode.mutate({ id: page.id, data });
  }, [page.id, page.name, page.is_daily, page.is_monthly, page.is_yearly, pageClassId, updateNode, createNode]);

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
              <>
                <input
                  type="text"
                  className={`page-title-input${!isNameEditable ? ' readonly' : ''}`}
                  value={inputValue}
                  onChange={(e) => handleInputChange(e.target.value)}
                  onBlur={(e) => handleNameChange(e.target.value)}
                  onKeyDown={handlePageTitleKeyDown}
                  placeholder="Untitled"
                  onClick={(e) => e.stopPropagation()}
                  readOnly={!isNameEditable}
                  title={!isNameEditable ? 'System page names cannot be edited' : undefined}
                />
                {renamePreview && (
                  <span className="page-title-child-preview">
                    {renamePreview.type === 'create-child' && `→ will create child: ${renamePreview.path}`}
                    {renamePreview.type === 'move-to-parent' && `→ will move under: ${renamePreview.parent}`}
                    {renamePreview.type === 'rename-and-move' && (
                      renamePreview.parent 
                        ? `→ will rename to "${renamePreview.newName}" and move under: ${renamePreview.parent}`
                        : `→ will rename to "${renamePreview.newName}"`
                    )}
                  </span>
                )}
              </>
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
