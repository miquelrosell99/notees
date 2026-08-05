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
import { copyToClipboard } from '@/utils/clipboardManager';
import { useUpdateNode, useClasses, useCreateNode, usePageClass, useClassClass, useAddClass } from '@/features/content';
import { useNodeDisplayName } from '@/features/queries';
import { listCorePagesAsync } from '@/core/query/listPages';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { parseIconField, formatIconField } from '@/utils/iconDom';
import { useNavigationStore } from '@/stores';
import { useAuthStore } from '@/features/auth';
import { useLivePresenceStore, liveSyncManager } from '@/features/collab';
import type { Node, NodeUpdate } from '@/types';
import { NodeIcon, Icon } from '@/components/ui/icons';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { SuggestionPopup } from './SuggestionPopup';
import { isSystemPage } from '@/utils/systemPages';
import { parseHierarchicalPath, resolveHierarchicalParentUuid } from '@/utils/hierarchicalPath';
import './PageHeader.css';

interface PageHeaderProps {
  /** The page node to display */
  page: Node;
  /** Effective class UUIDs (may include inherited classes from aliased node) */
  effectiveClasses?: string[];
  /** The aliased (main) node, if this page is an alias */
  aliasedNode?: Node | null;
  /** Callback when right-clicking the header (for context menu) */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Custom handler for name changes (overrides default node update) */
  onNameChange?: (name: string) => void;
  /** Custom handler for icon changes (overrides default node update) */
  onIconChange?: (icon: string) => void;
  /** When true, removes outer spacing so the header sits flush in an embedded grid. */
  embedded?: boolean;
  /** When true, fades non-essential chrome for focus mode. */
  focusMode?: boolean;
  /** Additional CSS class for the header root. */
  className?: string;
}

export function PageHeader({
  page,
  effectiveClasses,
  aliasedNode,
  onContextMenu,
  onNameChange,
  onIconChange,
  embedded = false,
  focusMode = false,
  className = '',
}: PageHeaderProps) {
  const currentUserId = useAuthStore((s) => s.user?.nodeUuid ?? 0);
  const titleUsers = useLivePresenceStore((s) => s.presence[page.uuid]?.[page.uuid]);
  const titleLockedBy = useMemo(
    () => (titleUsers ?? []).filter((u) => u.nodeUuid !== currentUserId),
    [titleUsers, currentUserId],
  );
  const isTitleLocked = titleLockedBy.length > 0;
  const iconRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const addClass = useAddClass();
  const { pageClassUuid } = usePageClass();
  const { classClassUuid } = useClassClass();
  const addSidebarCard = useNavigationStore((state) => state.addSidebarCard);
  const workspaceUuid = useCurrentWorkspaceUuid();

  // Icon picker state
  const [showIconPicker, setShowIconPicker] = useState(false);

  // + class popup state
  const [classPopupOpen, setClassPopupOpen] = useState(false);
  const [classQuery, setClassQuery] = useState('');
  
  // Local state for input value (to show preview before committing)
  const displayName = useNodeDisplayName(page);
  const [inputValue, setInputValue] = useState(displayName);

  useEffect(() => {
    setInputValue(displayName);
  }, [displayName]);
  
  // Adaptive title scale based on title length
  const titleSizeClass = useMemo(() => {
    const len = inputValue.length;
    if (len > 60) return 'page-title-input--compact';
    if (len > 40) return 'page-title-input--medium';
    return '';
  }, [inputValue]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const textarea = titleRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue, titleSizeClass]);
  
  // Get all classes (for effective icon calculation)
  const { data: allClasses } = useClasses();
  
  // Get effective icon (page's icon or first class's icon, using inherited classes for aliases)
  const effectiveIcon = useMemo(() => getEffectiveIcon(page, allClasses, effectiveClasses, aliasedNode), [page, allClasses, effectiveClasses, aliasedNode]);
  
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
    
    // Check for + trigger (class popup)
    // Match + at start of string or after whitespace, with no whitespace in the query after it
    const typingMatch = newValue.match(/(^|.*\s)\+(\S*)$/);
    if (typingMatch && isNameEditable) {
      const query = typingMatch[2];
      setClassQuery(query);
      setClassPopupOpen(true);
    } else {
      setClassPopupOpen(false);
    }
  }, [isNameEditable]);

  // Handle class selection from + popup
  const handleClassSelect = useCallback((classNode: Node) => {
    // Add class to this page
    addClass.mutate({ nodeUuid: page.uuid, classId: classNode.uuid });
    // Remove the +query text from the title
    const beforeAt = inputValue.substring(0, inputValue.lastIndexOf('+'));
    setInputValue(beforeAt.trimEnd());
    setClassPopupOpen(false);
    // Keep focus on textarea
    titleRef.current?.focus();
  }, [page.uuid, addClass, inputValue]);

  // Handle creating a new class from + popup
  const handleClassCreate = useCallback((name: string) => {
    if (!classClassUuid || !pageClassUuid) return;
    createNode.mutate({ name, class_uuids: [classClassUuid, pageClassUuid] }, {
      onSuccess: (newClass) => {
        // Add the new class to this page
        addClass.mutate({ nodeUuid: page.uuid, classId: newClass.uuid });
      }
    });
    // Remove the +query text from the title
    const beforeAt = inputValue.substring(0, inputValue.lastIndexOf('+'));
    setInputValue(beforeAt.trimEnd());
    setClassPopupOpen(false);
    titleRef.current?.focus();
  }, [page.uuid, classClassUuid, pageClassUuid, createNode, addClass, inputValue]);

  // Close class popup
  const handleClassPopupClose = useCallback(() => {
    // Remove the + text from the title when closing
    const beforeAt = inputValue.substring(0, inputValue.lastIndexOf('+'));
    setInputValue(beforeAt.trimEnd() || inputValue);
    setClassPopupOpen(false);
  }, [inputValue]);

  const handleNameChange = useCallback(async (newName: string) => {
    // Close class popup if open
    setClassPopupOpen(false);
    
    // Strip any trailing +query text (user blurred while typing a class trigger)
    const cleanName = newName.replace(/(^|\s)\+\S*$/, '').trimEnd() || newName;
    
    // Disable hierarchical creation for date pages (daily, monthly, yearly)
    const isDatePage = page.is_daily || page.is_monthly || page.is_yearly;
    
    // Check if the new name contains "/" and this is not a date page
    if (cleanName.includes('/') && !isDatePage && pageClassUuid) {
      const parsed = parseHierarchicalPath(cleanName);
      const originalName = page.name || '';
      
      // Case 1: User keeps original name at start and adds "/" after it 
      // (e.g., "Pokemon" → "Pokemon/Charizard" or "Pokemon/Gen1/Fire/Charizard")
      // Create child pages under the current page
      if (parsed.parentSegments.length > 0 && parsed.parentSegments[0] === originalName) {
        try {
          // Fetch fresh pages from API to avoid stale cache issues
          const freshPages = workspaceUuid ? await listCorePagesAsync(workspaceUuid) : [];
          // The child hierarchy starts after the original name
          const childSegments = parsed.parentSegments.slice(1);
          
          // Build lookup map for O(1) access
          const pageMap = new Map<string, Node>();
          for (const p of freshPages) {
            const key = `${p.name}|${p.parent_uuid ?? 'null'}`;
            pageMap.set(key, p);
          }

          // Resolve or create intermediate child pages
          let currentParent = page.uuid;
          for (const segment of childSegments) {
            const key = `${segment}|${currentParent}`;
            let node = pageMap.get(key);

            if (!node) {
              node = await createNode.mutateAsync({
                name: segment,
                class_uuids: [pageClassUuid],
                parent_uuid: currentParent,
              });
              // Add to map so subsequent iterations can find it
              pageMap.set(key, node);
            }

            currentParent = node.uuid;
          }

          // Create the final leaf page
          if (parsed.leaf) {
            createNode.mutate({
              name: parsed.leaf,
              class_uuids: [pageClassUuid],
              parent_uuid: currentParent,
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
          const freshPages = workspaceUuid ? await listCorePagesAsync(workspaceUuid) : [];

          // Resolve or create parent pages (supports multiple levels)
          const parentUuid = await resolveHierarchicalParentUuid(
            parsed.parentSegments,
            freshPages,
            async (name, parent) => {
              return await createNode.mutateAsync({
                name,
                parent_uuid: parent,
                class_uuids: [pageClassUuid],
              });
            }
          );

          // Move current page under the new parent
          updateNode.mutate({
            nodeUuid: page.uuid,
            data: { parent_uuid: parentUuid }
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
          const freshPages = workspaceUuid ? await listCorePagesAsync(workspaceUuid) : [];

          // Resolve or create parent pages (supports multiple levels)
          const parentUuid = await resolveHierarchicalParentUuid(
            parsed.parentSegments,
            freshPages,
            async (name, parent) => {
              return await createNode.mutateAsync({
                name,
                parent_uuid: parent,
                class_uuids: [pageClassUuid],
              });
            }
          );

          // Update page with new name and parent
          updateNode.mutate({
            nodeUuid: page.uuid,
            data: {
              name: parsed.leaf,
              parent_uuid: parentUuid
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
    if (onNameChange) {
      onNameChange(cleanName);
    } else {
      const data: NodeUpdate = { name: cleanName };
      updateNode.mutate({ nodeUuid: page.uuid, data });
    }
  }, [page.uuid, page.name, page.is_daily, page.is_monthly, page.is_yearly, pageClassUuid, updateNode, createNode, onNameChange]);

  // Handle icon change via emoji picker
  const handleIconClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setShowIconPicker((prev) => !prev);
  }, []);

  const handleIconSelect = useCallback((icon: string) => {
    const { color: existingColor } = parseIconField(page.icon ?? '');
    const encoded = icon ? formatIconField(icon, existingColor) : null;
    if (onIconChange) {
      onIconChange(encoded ?? '');
    } else {
      updateNode.mutate({ nodeUuid: page.uuid, data: { icon: encoded } });
    }
    setShowIconPicker(false);
  }, [page.uuid, page.icon, updateNode, onIconChange]);

  const handleIconColorChange = useCallback((color: string | null) => {
    const { icon: iconName } = parseIconField(page.icon ?? '');
    // Always store color even with no explicit icon so the inherited/default icon can be tinted
    const encoded = color ? formatIconField(iconName ?? '', color) : (iconName || null);
    updateNode.mutate({ nodeUuid: page.uuid, data: { icon: encoded } });
  }, [page.uuid, page.icon, updateNode]);

  // Handle Ctrl+C on page title to copy page link when nothing is selected
  const handlePageTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // When class popup is open, let SuggestionPopup handle navigation keys
    if (classPopupOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
        // SuggestionPopup captures these via document keydown listener
        // Just prevent default textarea behavior (newlines, etc.)
        e.preventDefault();
        return;
      }
    }
    
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const input = e.currentTarget;
      const hasSelection = input.selectionStart !== input.selectionEnd;
      if (!hasSelection && page.name) {
        e.preventDefault();
        copyToClipboard(page.uuid);
      }
    }
    // Prevent Enter from creating newlines - treat as blur instead
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }, [page.name, page.uuid, classPopupOpen]);

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      addSidebarCard(page.uuid, 'page');
    }
  }, [page.uuid, addSidebarCard]);

  return (
    <>
      <header
        className={`page-header ${className}`}
        data-embedded={embedded || undefined}
        data-focus-mode={focusMode || undefined}
        onClickCapture={handleHeaderClick}
        onContextMenu={onContextMenu}
      >
        {/* Title row: Icon + Title */}
        <div className="page-header__title-row">
          <button
            ref={iconRef}
            className="page-icon-btn"
            onClick={handleIconClick}
            title="Change icon"
            aria-label="Change icon"
          >
            {effectiveIcon || page.is_daily || page.is_monthly || page.is_yearly ? (
              <NodeIcon 
                icon={effectiveIcon} 
                isPage={true}
                size="xl" 
                className="page-icon-large"
              />
            ) : (
              <span className="page-icon-placeholder hover-reveal">+</span>
            )}
          </button>
          
          <div className="page-title-container">
            <h1 className="page-title-heading">
              <textarea
                ref={titleRef}
                className={`page-title-input${titleSizeClass ? ` ${titleSizeClass}` : ''}${!isNameEditable ? ' readonly' : ''}`}
                value={inputValue}
                onChange={(e) => handleInputChange(e.target.value)}
                onFocus={() => {
                  liveSyncManager.sendFocus(page.uuid);
                  useLivePresenceStore.getState().setLocalFocus(page.uuid, page.uuid);
                }}
                onBlur={(e) => {
                  liveSyncManager.sendBlur(page.uuid);
                  useLivePresenceStore.getState().setLocalFocus(page.uuid, null);
                  handleNameChange(e.target.value);
                }}
                onKeyDown={handlePageTitleKeyDown}
                placeholder="Untitled"
                onClick={(e) => e.stopPropagation()}
                readOnly={!isNameEditable}
                tabIndex={isNameEditable ? undefined : -1}
                spellCheck={false}
                title={!isNameEditable ? 'System page names cannot be edited' : undefined}
                rows={1}
                aria-label="Page title"
              />
            </h1>
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
            {isTitleLocked && (
              <span className="page-title-locked" title={`Editing by ${titleLockedBy.map((u) => u.name).join(', ')}`}>
                <Icon path="mdi mdi-lock-outline" size={0.7} color={titleLockedBy[0].color} />
              </span>
            )}
            {page.active === false && (
              <span className="archived-badge">Archived</span>
            )}
            {page.is_private && (
              <span className="private-badge">Private</span>
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
          anchorRef={iconRef}
          useColor={true}
          color={parseIconField(page.icon ?? '').color ?? null}
          onColorChange={handleIconColorChange}
        />
      )}

      {/* Class suggestion popup when typing @ in page title */}
      {classPopupOpen && (
        <SuggestionPopup
          isOpen={true}
          query={classQuery}
          type="class"
          anchorRef={titleRef}
          onSelect={(node) => handleClassSelect(node)}
          onClose={handleClassPopupClose}
          onCreate={handleClassCreate}
        />
      )}
    </>
  );
}

