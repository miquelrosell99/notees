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
import { useUpdateNode, useClasses, useCreateNode, useClassClass, useAddClass } from '@/features/content';
import { useNodeDisplayName } from '@/features/queries';
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
import { dayUuidToWeekday, monthUuidToMonthName } from '@/utils/dateUuid';
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
  /** Icon to show when the node has no effective icon, instead of the "+" placeholder. */
  defaultIcon?: string;
  /** When true, blurring with an empty name reverts to the current name instead of committing. */
  requireName?: boolean;
  /** When false, typing "+class" in the title does not open the class suggestion popup. */
  enableClassSuggestions?: boolean;
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
  defaultIcon,
  requireName = false,
  enableClassSuggestions = true,
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
  const { classClassUuid } = useClassClass();
  const addSidebarCard = useNavigationStore((state) => state.addSidebarCard);

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

  // Derive the weekday/month name badge for date pages
  const dateNameBadge = useMemo(() => {
    if (page.is_daily) return dayUuidToWeekday(page.uuid);
    if (page.is_monthly) return monthUuidToMonthName(page.uuid);
    return null;
  }, [page.uuid, page.is_daily, page.is_monthly]);

  const handleInputChange = useCallback((newValue: string) => {
    setInputValue(newValue);
    
    // Check for + trigger (class popup)
    // Match + at start of string or after whitespace, with no whitespace in the query after it
    const typingMatch = newValue.match(/(^|.*\s)\+(\S*)$/);
    if (typingMatch && isNameEditable && enableClassSuggestions) {
      const query = typingMatch[2];
      setClassQuery(query);
      setClassPopupOpen(true);
    } else {
      setClassPopupOpen(false);
    }
  }, [isNameEditable, enableClassSuggestions]);

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
    if (!classClassUuid) return;
    createNode.mutate({ name, kind: 'page', class_uuids: [classClassUuid] }, {
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
  }, [page.uuid, classClassUuid, createNode, addClass, inputValue]);

  // Close class popup
  const handleClassPopupClose = useCallback(() => {
    // Remove the + text from the title when closing
    const beforeAt = inputValue.substring(0, inputValue.lastIndexOf('+'));
    setInputValue(beforeAt.trimEnd() || inputValue);
    setClassPopupOpen(false);
  }, [inputValue]);

  const handleNameChange = useCallback((newName: string) => {
    // Close class popup if open
    setClassPopupOpen(false);

    // Strip any trailing +query text (user blurred while typing a class trigger)
    // Names are literal: "/" has no special meaning.
    const cleanName = newName.replace(/(^|\s)\+\S*$/, '').trimEnd() || newName;

    // Required names (e.g. classes): revert instead of committing an empty name.
    if (requireName && !cleanName.trim()) {
      setInputValue(displayName);
      return;
    }

    if (onNameChange) {
      onNameChange(cleanName);
    } else {
      const data: NodeUpdate = { name: cleanName };
      updateNode.mutate({ nodeUuid: page.uuid, data });
    }
  }, [page.uuid, updateNode, onNameChange, requireName, displayName]);

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
    // Honor the onIconChange override (property/class views persist icons elsewhere)
    if (onIconChange) {
      onIconChange(encoded ?? '');
    } else {
      updateNode.mutate({ nodeUuid: page.uuid, data: { icon: encoded } });
    }
  }, [page.uuid, page.icon, updateNode, onIconChange]);

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
    
    if (e.key === 'Escape') {
      // Revert uncommitted edits and blur (parity with the former ClassHeader).
      e.preventDefault();
      setInputValue(displayName);
      e.currentTarget.blur();
      return;
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
  }, [page.name, page.uuid, classPopupOpen, displayName]);

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
            ) : defaultIcon ? (
              <NodeIcon
                icon={defaultIcon}
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
            {dateNameBadge && (
              <span className="date-name-badge">{dateNameBadge}</span>
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

