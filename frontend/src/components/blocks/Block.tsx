/**
 * Block Component
 * 
 * Block component with 3 states: display, edit, selected (mutually exclusive)
 * 
 * Component Hierarchy:
 * Block
 *  ├─ BlockContainer   (layout, indent, selection state)
 *  ├─ BlockBullet      (Bullet component - drag handle, expand/collapse)
 *  ├─ BlockContent     (view mode - text with LinkPill/ClassPill tokens)
 *  │    ├─ TextToken
 *  │    ├─ LinkPill
 *  │    └─ ClassPill
 *  ├─ BlockEditor      (edit mode - rich text editing)
 *  └─ BlockChildren    (recursive child blocks)
 * 
 * Features:
 * - Bullet is the drag handle and context menu anchor
 * - Fixed width content area (adapts to container)
 * - No text placeholder for empty blocks
 * - Click on content enters edit mode
 * - Click outside exits edit mode to display
 * - Escape in edit mode selects the block
 * - Drag selection for multi-select
 * - Keyboard selection with Shift+arrows
 * - Children auto-selected when parent is selected
 * - Shift+click on bullet opens in sidebar
 */
import React, { useRef, useEffect, useCallback, useState, useMemo, memo } from 'react';
import { useBlockSelectionStore, type BlockState } from '@/stores/blockSelectionStore';
import { useMoveNode, useUpdateNode, useDeleteNode, useCreateNode, useClasses, useRemoveClass, useBlockOperation } from '@/hooks';
import { useIsBlockSelected, useIsPrimarySelected, useBlockState as useBlockStateSelector, useIsBlockDragging, useSelectionMode, useOpenNodeAction, useEditorSelectionActions, useBlockNavigationActions, useVisibleBlockIds, useBlockParentMap } from '@/stores';
import { BlockEditor, type TaskState } from './BlockEditor';
import { BlockContent } from './BlockContent';
import { Bullet } from './Bullet';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { ContextMenu } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { ColorPickerRow } from '../nodes/NodeContextMenu';
import { NodeClassPill } from '../NodeClassPill';
import { SYSTEM_CLASS_UUIDS, isSystemClassUuid } from '@/constants';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Node } from '@/types';
import { getNodeColorStylesAuto } from '@/utils/color';
import './Block.css';

interface BlockProps {
  block: Node;
  children?: Node[];
  /** Sibling blocks at the same level (for merge operations) */
  siblings?: Node[];
  depth?: number;
  parentId: number | null;
  /** Parent block (for merging up into parent) */
  parentBlock?: Node | null;
  onContentChange?: (blockId: number, content: string) => void;
  onBulletClick?: (blockId: number) => void;
  onShiftClick?: (blockId: number) => void;
  onAddClass?: (classNodeId: number, keepInline: boolean, className: string) => void;
  onAddTag?: (tagNodeId: number, keepInline: boolean, tagName: string) => void;
  onCreateClass?: (name: string, keepInline: boolean) => void;
  onCreateTag?: (name: string, keepInline: boolean) => void;
  onLinkPage?: (pageNode: Node) => void;
  onCreatePageLink?: (name: string) => Promise<string | undefined>;  // Returns the new page ID
  onOpenComments?: () => void;
  onAssetUpload?: (assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) => void;
  commentCount?: number;
  backlinkCount?: number;
  /** Callback when task state changes (Shift+Enter) */
  onTaskStateChange?: (blockId: number, newState: string) => void;
  /** Ref to the editor element for focus management */
  editorRef?: React.RefObject<HTMLDivElement>;
  /** Callback when backlinks badge is clicked */
  onOpenBacklinks?: () => void;
  
  // ============== Capability Flags ==============
  /** Whether the block can be moved/reordered via drag-drop (default: true) */
  canMove?: boolean;
  /** Whether the block content can be edited (default: true) */
  canEdit?: boolean;
  /** Whether the block participates in selection (default: true) */
  canSelect?: boolean;
  /** Whether to show the bullet (default: true) */
  showBullet?: boolean;
  /** Whether to show the type pills (default: true) */
  showTypes?: boolean;
  /** Whether to render children blocks (default: true) */
  showChildren?: boolean;
  /** Use isolated local state instead of global block selection store. Use for blocks that appear in multiple places (e.g., linked references) */
  isolatedState?: boolean;
  /** Suppress the block's own color styling (used when color is applied at container level, e.g., focused blocks) */
  suppressColor?: boolean;
}

// Internal component function - use Block or MemoizedBlock exports
function BlockInternal({
  block,
  children = [],
  siblings = [],
  depth = 0,
  parentId,
  parentBlock,
  onContentChange,
  onBulletClick,
  onShiftClick,
  onAddClass,
  onAddTag,
  onCreateClass,
  onCreateTag,
  onLinkPage,
  onCreatePageLink,
  onOpenComments,
  onAssetUpload,
  commentCount = 0,
  backlinkCount = 0,
  onTaskStateChange,
  onOpenBacklinks,
  // Capability flags
  canMove = true,
  canEdit = true,
  canSelect = true,
  showBullet = true,
  showTypes = true,
  showChildren = true,
  isolatedState = false,
  suppressColor = false,
}: BlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside' | null>(null);
  const [isLineHovered, setIsLineHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  
  // Local state for isolated mode (blocks that appear in multiple places like linked references)
  const [localBlockState, setLocalBlockState] = useState<BlockState>('display');
  
  const moveNode = useMoveNode();
  const updateNode = useUpdateNode();
  const deleteNode = useDeleteNode();
  const createNode = useCreateNode();
  const removeClass = useRemoveClass();
  const { data: allClasses } = useClasses();
  
  // PERFORMANCE: Use action-only selector to avoid re-renders on state changes
  const openNode = useOpenNodeAction();
  
  // Editor selection actions for model-first cursor management
  const { setPendingCaret } = useEditorSelectionActions();
  
  // Block navigation actions for visual order navigation
  const { getNextBlockId } = useBlockNavigationActions();
  
  // Visible blocks list and parent map for hierarchy lookups
  const visibleBlockIds = useVisibleBlockIds();
  const blockParentMapFromStore = useBlockParentMap();
  
  // Operation queue for race condition protection on structural operations
  const { wrapOperation } = useBlockOperation();
  
  // PERFORMANCE: Use fine-grained selectors for selection state
  // These only trigger re-renders when THIS block's state changes
  const globalIsSelected = useIsBlockSelected(block.id);
  const globalIsPrimarySelected = useIsPrimarySelected(block.id);
  const globalBlockState = useBlockStateSelector(block.id);
  const globalIsBeingDragged = useIsBlockDragging(block.id);
  const selectionMode = useSelectionMode();
  
  // Resolve class details from IDs (excluding the implicit "page" class)
  const blockClassDetails = useMemo(() => {
    const classIds = block.classes ?? block.types;
    if (!classIds || classIds.length === 0 || !allClasses) return [];
    return classIds
      .map(classId => allClasses.find(c => c.id === classId))
      .filter((c): c is Node => c !== undefined && c.uuid !== SYSTEM_CLASS_UUIDS.page);
  }, [block.classes, block.types, allClasses]);
  
  // Determine the icon to show on the bullet
  // Priority: block's own icon > first class's icon
  const bulletIcon = useMemo(() => {
    // Prefer block's own icon first
    if (block.icon) {
      return block.icon;
    }
    // Fall back to first class's icon if block has no icon
    if (blockClassDetails.length > 0) {
      const firstClassWithIcon = blockClassDetails.find(c => c.icon);
      if (firstClassWithIcon?.icon) {
        return firstClassWithIcon.icon;
      }
    }
    return null;
  }, [block.icon, blockClassDetails]);
  
  // Determine if block has children
  const hasChildren = children && children.length > 0;
  const isCollapsed = block.collapsed ?? false;
  
  // PERFORMANCE: Only subscribe to actions and non-per-block state
  // Per-block state (selection, editing) comes from optimized selectors above
  const {
    selectBlock,
    addToSelection,
    startDrag,
    updateDragTarget,
    endDrag,
    registerBlock,
    unregisterBlock,
    setBlockState: setGlobalBlockState,
    extendSelectionKeyboard,
    blockParentMap,
    clearSelection,
    selectedBlockIds, // Still need for multi-select operations
  } = useBlockSelectionStore();
  
  // Get block state - use local state for isolated blocks, global state otherwise
  // If canEdit is false, always stay in display state
  const resolvedBlockState: BlockState = !canEdit ? 'display' : globalBlockState;
  const blockState: BlockState = isolatedState ? localBlockState : resolvedBlockState;
  
  // Wrapper to set block state - uses local or global based on isolatedState
  const setBlockState = useCallback((blockId: number, state: BlockState) => {
    if (!canEdit && state === 'edit') return; // Prevent entering edit mode if canEdit is false
    if (isolatedState) {
      setLocalBlockState(state);
    } else {
      setGlobalBlockState(blockId, state);
    }
  }, [isolatedState, setGlobalBlockState, canEdit]);
  
  // For isolated blocks or non-selectable blocks, selection is handled locally/disabled
  const isSelected = (isolatedState || !canSelect) ? false : globalIsSelected;
  const isPrimarySelected = (isolatedState || !canSelect) ? false : globalIsPrimarySelected;
  const isEditing = blockState === 'edit';
  const isBeingDragged = (isolatedState || !canMove) ? false : globalIsBeingDragged;
  
  // Register this block element (skip for isolated/non-selectable blocks to avoid conflicts)
  useEffect(() => {
    if (isolatedState || !canSelect) return; // Don't register non-selectable blocks
    if (containerRef.current) {
      registerBlock(block.id, containerRef.current);
    }
    return () => {
      if (!isolatedState && canSelect) unregisterBlock(block.id);
    };
  }, [block.id, registerBlock, unregisterBlock, isolatedState, canSelect]);
  
  // Clear local drag state when global drag ends (handles edge cases where dragend doesn't fire on element)
  useEffect(() => {
    const handleGlobalDragEnd = () => {
      setIsDragOver(false);
      setDropPosition(null);
    };
    
    document.addEventListener('dragend', handleGlobalDragEnd);
    document.addEventListener('drop', handleGlobalDragEnd);
    
    return () => {
      document.removeEventListener('dragend', handleGlobalDragEnd);
      document.removeEventListener('drop', handleGlobalDragEnd);
    };
  }, []);
  
  // Handle click outside to exit edit mode
  useEffect(() => {
    if (blockState !== 'edit') return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        setBlockState(block.id, 'display');
      }
    };
    
    // Use capture phase to ensure we get the event before other handlers
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [block.id, blockState, setBlockState]);
  
  // Handle drag start
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!canMove) return;
    
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(block.id));
    
    // Create custom drag image
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const dragImage = containerRef.current.cloneNode(true) as HTMLElement;
      dragImage.style.width = `${rect.width}px`;
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-9999px';
      dragImage.style.opacity = '0.8';
      dragImage.classList.add('dragging-preview');
      document.body.appendChild(dragImage);
      e.dataTransfer.setDragImage(dragImage, 20, 20);
      
      // Clean up drag image after a short delay
      setTimeout(() => {
        document.body.removeChild(dragImage);
      }, 0);
    }
    
    startDrag(block.id);
  }, [block.id, canMove, startDrag]);
  
  // Handle drag over
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!canMove || isBeingDragged) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;
    
    // Determine drop position based on mouse position
    let position: 'before' | 'after' | 'inside';
    if (y < height * 0.25) {
      position = 'before';
    } else if (y > height * 0.75) {
      position = 'after';
    } else {
      position = 'inside';
    }
    
    setIsDragOver(true);
    setDropPosition(position);
    updateDragTarget(block.id, position);
  }, [block.id, isBeingDragged, canMove, updateDragTarget]);
  
  // Handle drag leave
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if we're actually leaving this element
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (containerRef.current && !containerRef.current.contains(relatedTarget)) {
      setIsDragOver(false);
      setDropPosition(null);
    }
  }, []);
  
  // Handle drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Capture the current drop position before clearing state
    const currentDropPosition = dropPosition;
    const targetParentId = parentId;
    const targetSequence = block.sequence;
    
    // Always clear local state first
    setIsDragOver(false);
    setDropPosition(null);
    
    if (!canMove || isBeingDragged) {
      endDrag();
      return;
    }
    
    const draggedBlockId = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (isNaN(draggedBlockId) || draggedBlockId === block.id) {
      endDrag();
      return;
    }
    
    // Don't allow dropping onto self or descendants
    if (!currentDropPosition) {
      endDrag();
      return;
    }
    
    // End drag state before mutation to avoid stale UI
    endDrag();
    
    // Perform the move based on drop position
    if (currentDropPosition === 'inside') {
      // Move as first child of target block
      moveNode.mutate({
        id: draggedBlockId,
        parentId: block.id,
        position: 0,
      });
    } else if (currentDropPosition === 'before') {
      // Move before target block (same parent as target)
      moveNode.mutate({
        id: draggedBlockId,
        parentId: targetParentId,
        position: targetSequence,
      });
    } else if (currentDropPosition === 'after') {
      // Move after target block (same parent as target)
      moveNode.mutate({
        id: draggedBlockId,
        parentId: targetParentId,
        position: targetSequence + 1,
      });
    }
  }, [block.id, block.sequence, dropPosition, endDrag, isBeingDragged, moveNode, parentId, canMove]);
  
  // Handle drag end
  const handleDragEnd = useCallback(() => {
    setIsDragOver(false);
    setDropPosition(null);
    endDrag();
  }, [endDrag]);
  
  // Handle block click (for selection)
  const handleBlockClick = useCallback((e: React.MouseEvent) => {
    if (!canSelect) return;
    
    // Shift+click adds to selection
    if (e.shiftKey) {
      e.preventDefault();
      addToSelection(block.id);
      return;
    }
    
    // Regular click outside content area doesn't do anything special
    // Content area click is handled by handleContentClick
  }, [addToSelection, block.id, canSelect]);
  
  // Calculate cursor position from click event using browser's caret position APIs
  const getCursorPositionFromClick = useCallback((e: React.MouseEvent): number | undefined => {
    const content = block.name || '';
    if (!content || !contentRef.current) return undefined;
    
    // Use caretPositionFromPoint (standard) or caretRangeFromPoint (WebKit fallback)
    // These APIs correctly handle complex DOM with inline elements like pills
    let range: Range | null = null;
    
    // Try standard API first (Firefox, newer browsers)
    if ('caretPositionFromPoint' in document) {
      const pos = (document as any).caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    // Fallback to WebKit API (Chrome, Safari)
    else if ('caretRangeFromPoint' in document) {
      range = (document as Document).caretRangeFromPoint(e.clientX, e.clientY);
    }
    
    if (!range) return undefined;
    
    // Now convert the DOM position to a plain text position
    // We need to walk through the DOM and count characters, treating pills as their raw content
    const container = contentRef.current;
    const rangeStartContainer = range.startContainer;
    const rangeStartOffset = range.startOffset;
    
    // Recursive function to calculate position
    function calculatePosition(node: globalThis.Node, foundTarget: { found: boolean, position: number }): number {
      if (foundTarget.found) return foundTarget.position;
      
      // Check if this is the target node
      if (node === rangeStartContainer) {
        foundTarget.found = true;
        if (node.nodeType === Node.TEXT_NODE) {
          foundTarget.position += rangeStartOffset;
        }
        return foundTarget.position;
      }
      
      if (node.nodeType === Node.TEXT_NODE) {
        foundTarget.position += node.textContent?.length || 0;
        return foundTarget.position;
      }
      
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        
        // Check for pills - use their raw content length and skip children
        if (el.classList?.contains('link-pill')) {
          const raw = el.dataset?.linkRaw || '';
          foundTarget.position += raw.length;
          return foundTarget.position;
        } else if (el.classList?.contains('type-pill')) {
          const raw = el.dataset?.typeRaw || '';
          foundTarget.position += raw.length;
          return foundTarget.position;
        } else if (el.classList?.contains('tag-pill')) {
          const raw = el.dataset?.linkRaw || '';
          foundTarget.position += raw.length;
          return foundTarget.position;
        }
        
        // For other elements, recurse into children
        for (const child of el.childNodes) {
          calculatePosition(child, foundTarget);
          if (foundTarget.found) break;
        }
      }
      
      return foundTarget.position;
    }
    
    const result = { found: false, position: 0 };
    calculatePosition(container, result);
    
    return result.found ? result.position : undefined;
  }, [block.name]);
  
  // Handle content area click - enters edit mode
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    if (!canEdit) return;
    
    e.stopPropagation();
    
    // Calculate cursor position from click and set via model-first approach
    const cursorPos = getCursorPositionFromClick(e);
    if (cursorPos !== undefined) {
      setPendingCaret(block.id, cursorPos);
    } else {
      // Position at end if click position couldn't be determined
      setPendingCaret(block.id, (block.name || '').length);
    }
    
    // Enter edit mode
    setBlockState(block.id, 'edit');
  }, [block.id, block.name, canEdit, setBlockState, getCursorPositionFromClick, setPendingCaret]);
  
  // Handle deleting a link from block content (replaces [[link]] with plain text)
  const handleDeleteLink = useCallback((raw: string) => {
    if (!block.name || !canEdit) return;
    
    // Remove the link syntax, keeping just the displayed text if needed
    // The raw value is the full link syntax like "[[123]]"
    const newContent = block.name.replace(raw, '');
    onContentChange?.(block.id, newContent);
  }, [block.id, block.name, canEdit, onContentChange]);
  
  // Handle bullet click for navigation
  const handleBulletClickInternal = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      e.stopPropagation();
      
      // In selection mode, open all selected blocks in sidebar
      if (isSelected && selectedBlockIds.size > 1) {
        // Open all selected blocks (call onShiftClick for each)
        selectedBlockIds.forEach(id => onShiftClick(id));
      } else {
        onShiftClick(block.id);
      }
    } else if (onBulletClick) {
      e.preventDefault();
      e.stopPropagation();
      onBulletClick(block.id);
    }
  }, [block.id, isSelected, onBulletClick, onShiftClick, selectedBlockIds]);
  
  // Handle collapse toggle (clicking the vertical line or arrow)
  const handleCollapseToggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateNode.mutate({
      id: block.id,
      data: { collapsed: !isCollapsed }
    });
  }, [block.id, isCollapsed, updateNode]);
  
  // Handle bullet context menu (right-click)
  const handleBulletContextMenu = useCallback((_nodeId: number, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);
  
  // Close context menu
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);
  
  // Context menu items for blocks
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const items: (ContextMenuItem | null)[] = [
      {
        id: 'open',
        label: 'Open in focused view',
        shortcut: 'Click',
        onClick: () => {
          if (onBulletClick) onBulletClick(block.id);
          handleCloseContextMenu();
        }
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          if (onShiftClick) onShiftClick(block.id);
          handleCloseContextMenu();
        }
      },
      { id: 'sep1', label: '', separator: true },
      {
        id: 'duplicate',
        label: 'Duplicate',
        shortcut: '⌘D',
        onClick: () => {
          // TODO: Implement duplicate node
          handleCloseContextMenu();
        },
        disabled: true // Not yet implemented
      },
      {
        id: 'copy-link',
        label: 'Copy block link',
        shortcut: '⌥⌘C',
        onClick: () => {
          const link = `@[[${block.uuid || block.id}]]`;
          navigator.clipboard.writeText(link);
          handleCloseContextMenu();
        }
      },
      { id: 'sep2', label: '', separator: true },
      {
        id: 'indent',
        label: 'Indent',
        shortcut: 'Tab',
        onClick: () => {
          // Find previous sibling to make parent
          // This would need access to siblings - for now just close
          handleCloseContextMenu();
        },
        disabled: true // Would need sibling context
      },
      {
        id: 'outdent',
        label: 'Outdent',
        shortcut: '⇧Tab',
        onClick: () => {
          // Move to parent's parent
          handleCloseContextMenu();
        },
        disabled: !parentId // Can't outdent if no parent
      },
      { id: 'sep3', label: '', separator: true },
      hasChildren ? {
        id: 'collapse',
        label: isCollapsed ? 'Expand' : 'Collapse',
        shortcut: '⌘↓',
        onClick: () => {
          updateNode.mutate({
            id: block.id,
            data: { collapsed: !isCollapsed }
          });
          handleCloseContextMenu();
        }
      } : null,
      {
        id: 'delete',
        label: 'Delete',
        shortcut: '⌫',
        danger: true,
        onClick: () => {
          if (block.is_page) {
            setShowDeleteModal(true);
          } else {
            deleteNode.mutate(block.id);
          }
          handleCloseContextMenu();
        }
      }
    ];
    return items.filter((item): item is ContextMenuItem => item !== null);
  }, [
    block.id, block.uuid, block.is_page, hasChildren, isCollapsed, parentId,
    onBulletClick, onShiftClick, updateNode, deleteNode, handleCloseContextMenu
  ]);
  
  // Handle keyboard events
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Escape in edit mode selects the block
    if (e.key === 'Escape' && isEditing) {
      e.preventDefault();
      setBlockState(block.id, 'selected');
      return;
    }
    
    // Escape in selected mode clears selection (returns to display)
    if (e.key === 'Escape' && blockState === 'selected') {
      e.preventDefault();
      setBlockState(block.id, 'display');
      return;
    }
    
    // Only handle navigation when not editing
    if (isEditing && e.key !== 'Escape') return;
    
    // Arrow key navigation with shift for selection
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      
      if (e.shiftKey) {
        // Shift+Arrow extends selection using new keyboard selection logic
        e.preventDefault();
        extendSelectionKeyboard(direction);
      } else if (selectionMode === 'selected') {
        // Arrow in selected mode navigates
        e.preventDefault();
        const nextId = getNextBlockId(block.id, direction);
        if (nextId) {
          selectBlock(nextId);
        }
      }
    }
    
    // Enter in selected mode enters edit mode
    if (e.key === 'Enter' && blockState === 'selected' && !e.shiftKey) {
      e.preventDefault();
      setBlockState(block.id, 'edit');
    }
    
    // Delete/Backspace in selected mode deletes selected blocks
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectionMode === 'selected' && selectedBlockIds.size > 0) {
      e.preventDefault();
      // Delete blocks starting from deepest level to avoid cascade issues
      // Sort by depth (blocks with more ancestors first)
      const blockIdsToDelete = Array.from(selectedBlockIds);
      
      // Sort by depth: blocks that are children of other selected blocks should be deleted first
      // Actually, we should NOT delete children separately if their parent is being deleted
      // Filter out blocks whose ancestors are also in the selection (they'll be cascade deleted)
      const rootBlocksToDelete = blockIdsToDelete.filter(id => {
        // Check if any ancestor of this block is also selected
        let currentParentId = blockParentMap.get(id);
        while (currentParentId !== null && currentParentId !== undefined) {
          if (selectedBlockIds.has(currentParentId)) {
            // This block's parent is selected, it will be cascade deleted
            return false;
          }
          currentParentId = blockParentMap.get(currentParentId);
        }
        return true;
      });
      
      // Delete each root block (children will cascade)
      rootBlocksToDelete.forEach(id => {
        deleteNode.mutate(id);
      });
      
      // Clear selection after deletion
      clearSelection();
    }
  }, [block.id, blockState, extendSelectionKeyboard, getNextBlockId, isEditing, selectBlock, selectionMode, setBlockState, selectedBlockIds, blockParentMap, deleteNode, clearSelection]);
  
  // Handle focus (enter edit mode)
  const handleFocus = useCallback(() => {
    if (canEdit && blockState !== 'edit') {
      setBlockState(block.id, 'edit');
    }
  }, [block.id, blockState, canEdit, setBlockState]);
  
  // Compute class names
  const classNames = useMemo(() => {
    const classes = ['block', `block-state--${blockState}`];
    if (isSelected) classes.push('selected');
    if (isPrimarySelected) classes.push('primary-selected');
    if (isEditing) classes.push('editing');
    if (isBeingDragged) classes.push('dragging');
    // Only add drop-inside for background highlight, other positions use drop indicator elements
    if (isDragOver && dropPosition === 'inside') classes.push('drop-inside');
    if (depth > 0) classes.push('nested');
    if (block.color) classes.push('has-color');
    if (hasChildren) classes.push('has-children');
    if (isCollapsed) classes.push('collapsed');
    if (!canEdit) classes.push('readonly');
    return classes.join(' ');
  }, [blockState, isSelected, isPrimarySelected, isEditing, isBeingDragged, isDragOver, dropPosition, depth, block.color, hasChildren, isCollapsed, canEdit]);
  
  // Indentation style (color now applied to block-content only)
  const blockStyle = useMemo(() => {
    const style: React.CSSProperties = {};
    // Note: Nested indentation is now handled by children-container CSS
    return style;
  }, []);
  
  // Color style for block content - uses gradient border + tint pattern (same as NodeView)
  // suppressColor is used when the block's color is applied at the container level (e.g., focused blocks)
  const contentColorStyle = useMemo(() => {
    if (suppressColor || !block.color) return undefined;
    return getNodeColorStylesAuto(block.color);
  }, [block.color, suppressColor]);
  
  // Handlers for deletion modal
  const handleConfirmDelete = useCallback(() => {
    deleteNode.mutate(block.id);
    setShowDeleteModal(false);
  }, [block.id, deleteNode]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
  }, []);
  
  // Handle Enter key creating a new block
  const handleEnterCreateBlock = useCallback((textBefore: string, textAfter: string) => {
    // Update current block with text before cursor
    if (textBefore !== block.name) {
      updateNode.mutate({
        id: block.id,
        data: { name: textBefore }
      });
    }
    
    // Determine where to create the new block:
    // - If current block has children, create as first child (sequence 0)
    // - Otherwise, create as sibling after current block
    const newBlockParentId = hasChildren ? block.id : parentId;
    const newBlockSequence = hasChildren ? 0 : block.sequence + 1;
    
    createNode.mutate(
      {
        name: textAfter,
        parent_id: newBlockParentId,
        sequence: newBlockSequence,
      },
      {
        onSuccess: (newNode) => {
          // Set pending caret at start of new block (cursor at position 0)
          setPendingCaret(newNode.id, 0);
          // Set the new block to edit mode
          setBlockState(newNode.id, 'edit');
        },
      }
    );
  }, [block.id, block.name, block.sequence, hasChildren, parentId, updateNode, createNode, setBlockState, setPendingCaret]);
  
  // Handle Backspace at start of block - delete block and merge text with visual block above
  // Rules:
  // - Don't merge if current block has children
  // - Don't merge if block above is at a lower hierarchy level (deeper/child)
  // 
  // Level-agnostic: works at any nesting depth
  const handleBackspaceAtStart = useCallback((remainingText: string) => {
    // Don't merge if current block has children
    if (children && children.length > 0) {
      return;
    }
    
    // Try to find the previous block using store (works for blocks already in hierarchy)
    let prevBlockId = getNextBlockId(block.id, 'up');
    
    // Fallback: If store doesn't have this block yet (e.g., optimistic updates),
    // use prop-based navigation (previous sibling, or parent if first child)
    if (!prevBlockId) {
      const currentIndex = siblings.findIndex(s => s.id === block.id);
      if (currentIndex > 0) {
        // Previous sibling exists
        const prevSibling = siblings[currentIndex - 1];
        // If prev sibling has children, the visual previous is the last descendant
        // But for merge purposes, we merge with the sibling itself (same level)
        prevBlockId = prevSibling.id;
      } else if (parentBlock && !parentBlock.is_page) {
        // First child - merge with parent (which is at a higher level, OK)
        prevBlockId = parentBlock.id;
      }
    }
    
    if (!prevBlockId) {
      // No block above to merge into (we're at the top)
      return;
    }
    
    // Determine the previous block's parent for hierarchy checks
    // First try the store, then fall back to props
    let prevBlockParentId: number | null | undefined = blockParentMapFromStore.get(prevBlockId);
    let currentBlockParentId: number | null | undefined = blockParentMapFromStore.get(block.id);
    
    // Fallback for current block parent if not in store
    if (currentBlockParentId === undefined) {
      currentBlockParentId = parentId;
    }
    
    // Fallback for prev block parent - check if it's a sibling or the parent itself
    if (prevBlockParentId === undefined) {
      if (parentBlock && prevBlockId === parentBlock.id) {
        // Prev block IS the parent - its parent is grandparent
        prevBlockParentId = parentBlock.parent_id;
      } else if (siblings.some(s => s.id === prevBlockId)) {
        // Prev block is a sibling - same parent
        prevBlockParentId = parentId;
      }
    }
    
    // Check if the previous block is at a lower hierarchy level (deeper nested)
    // We can only merge with blocks at the same level or higher (less nested)
    
    // If the previous block's parent is the current block, it's a child - can't merge
    if (prevBlockParentId === block.id) {
      return;
    }
    
    // If prev block is our sibling (same parent), allow merge
    // If prev block is our parent (prevBlockId === parentBlock?.id), allow merge
    // If prev block is deeper than us, disallow merge
    
    // Check if prev block is at same level (same parent) - always OK
    const isSameLevel = prevBlockParentId === currentBlockParentId;
    
    // Check if prev block is our parent - OK (merging up to parent)
    const isPrevOurParent = parentBlock && prevBlockId === parentBlock.id;
    
    if (!isSameLevel && !isPrevOurParent) {
      // Different levels - need to check if prev is deeper (not allowed)
      // Walk up from prevBlock's parent to see if we hit current block
      let checkId: number | null | undefined = prevBlockParentId;
      while (checkId !== null && checkId !== undefined) {
        if (checkId === block.id) {
          // Previous block is a descendant of current block - can't merge
          return;
        }
        if (checkId === currentBlockParentId) {
          // Found common ancestor, prev is at same or higher level
          break;
        }
        checkId = blockParentMapFromStore.get(checkId);
      }
    }
    
    // Find the previous block data
    const findBlockData = (id: number): Node | null => {
      // Check if it's the parent
      if (parentBlock && parentBlock.id === id) return parentBlock;
      
      // Check siblings
      const sibling = siblings.find(s => s.id === id);
      if (sibling) return sibling;
      
      // Check children of siblings (for nested blocks)
      for (const sib of siblings) {
        if (sib.children) {
          const found = findInTree(sib.children, id);
          if (found) return found;
        }
      }
      
      return null;
    };
    
    // Helper to find node in tree
    const findInTree = (nodes: Node[], id: number): Node | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = findInTree(node.children, id);
          if (found) return found;
        }
      }
      return null;
    };
    
    const targetBlock = findBlockData(prevBlockId);
    
    // Get target content - even if we can't find the block data from props,
    // we can still attempt the merge
    const targetContent = targetBlock?.name || '';
    const cursorPosition = targetContent.length;
    const mergedContent = targetContent + remainingText;
    
    // Set pending caret BEFORE mutations - this will be restored after re-render
    setPendingCaret(prevBlockId, cursorPosition);
    
    // If we found target block data and there's remaining text, merge it
    if (remainingText && targetBlock) {
      updateNode.mutate({
        id: prevBlockId,
        data: { name: mergedContent }
      });
    }
    
    // Delete current block
    deleteNode.mutate(block.id);
    
    // Set target block to edit mode
    setBlockState(prevBlockId, 'edit');
  }, [block.id, children, getNextBlockId, blockParentMapFromStore, parentId, parentBlock, siblings, updateNode, deleteNode, setBlockState, setPendingCaret]);
  
  // Handle Delete at end of block - merge next block's text into current
  // Rules:
  // - Don't merge if next block has children
  // - Don't merge if next block is at a higher hierarchy level (parent/ancestor)
  const handleDeleteAtEnd = useCallback(() => {
    // Use visual order to find the block visually below
    const nextBlockId = getNextBlockId(block.id, 'down');
    
    if (!nextBlockId) {
      // No block below to merge
      return;
    }
    
    // Check if the next block is at a higher hierarchy level (we can't merge with parents)
    // A block is "higher" if it's an ancestor of the current block
    const nextBlockParentId = blockParentMapFromStore.get(nextBlockId);
    const currentBlockParentId = blockParentMapFromStore.get(block.id);
    
    // If the next block's parent is different and the next block isn't our child,
    // check if we're trying to merge "up" the hierarchy
    const isNextBlockOurChild = nextBlockParentId === block.id;
    const isNextBlockOurSibling = nextBlockParentId === currentBlockParentId;
    
    // Only allow merge with siblings or our own children (going "down" into nested)
    // Don't allow merge with blocks at a higher level (e.g., parent's next sibling)
    if (!isNextBlockOurChild && !isNextBlockOurSibling) {
      // Check if the next block is at a higher level
      // This happens when we're at the last block of a nested level and arrow down
      // goes to the parent's next sibling
      let checkParentId: number | null | undefined = currentBlockParentId;
      let foundAsAncestor = false;
      while (checkParentId !== null && checkParentId !== undefined) {
        if (checkParentId === nextBlockId) {
          foundAsAncestor = true;
          break;
        }
        checkParentId = blockParentMapFromStore.get(checkParentId);
      }
      
      // If the next block is an ancestor or at a higher level, don't merge
      if (foundAsAncestor || (nextBlockParentId !== currentBlockParentId && !isNextBlockOurChild)) {
        return;
      }
    }
    
    // Find the next block data
    const findBlockData = (id: number): Node | null => {
      // Check children first (for merging with our own children)
      if (children.length > 0) {
        const child = children.find(c => c.id === id);
        if (child) return child;
        // Check nested children
        for (const c of children) {
          if (c.children) {
            const found = findInTree(c.children, id);
            if (found) return found;
          }
        }
      }
      
      // Check siblings
      const sibling = siblings.find(s => s.id === id);
      if (sibling) return sibling;
      
      return null;
    };
    
    const findInTree = (nodes: Node[], id: number): Node | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = findInTree(node.children, id);
          if (found) return found;
        }
      }
      return null;
    };
    
    const nextBlock = findBlockData(nextBlockId);
    
    if (!nextBlock) {
      // Can't find block data - might be outside our tree context
      return;
    }
    
    // Check if the next block has children - don't merge if so
    const nextBlockHasChildren = nextBlock.children && nextBlock.children.length > 0;
    if (nextBlockHasChildren) {
      return;
    }
    
    // Append next block's content to current block
    const currentContent = block.name || '';
    const nextContent = nextBlock.name || '';
    const mergedContent = currentContent + nextContent;
    
    // Update current block with merged content
    updateNode.mutate({
      id: block.id,
      data: { name: mergedContent }
    });
    
    // Delete the next block
    deleteNode.mutate(nextBlockId);
  }, [block.id, block.name, children, siblings, getNextBlockId, blockParentMapFromStore, updateNode, deleteNode]);
  
  // Handle Tab - indent block (move as child of previous sibling)
  const handleIndent = useCallback(() => {
    const currentIndex = siblings.findIndex(s => s.id === block.id);
    const prevSibling = currentIndex > 0 ? siblings[currentIndex - 1] : null;
    
    if (!prevSibling) {
      // No previous sibling to indent into
      return;
    }
    
    // Move block as last child of previous sibling
    // Get the number of children the previous sibling has to determine position
    const prevSiblingChildCount = prevSibling.children?.length || 0;
    
    moveNode.mutate({
      id: block.id,
      parentId: prevSibling.id,
      position: prevSiblingChildCount, // Add as last child
    });
  }, [block.id, siblings, moveNode]);
  
  // Handle Shift+Tab - outdent block (move to parent's level after parent)
  const handleOutdent = useCallback(() => {
    if (!parentId || !parentBlock) {
      // Can't outdent if no parent
      return;
    }
    
    // If parent is a page, we're at top level - can't outdent further
    if (parentBlock.is_page) {
      return;
    }
    
    // Get the parent's parent and the parent's sequence to position correctly
    // grandparentId could be a page (for top-level blocks) or another block
    const grandparentId = parentBlock.parent_id;
    if (grandparentId === null || grandparentId === undefined) {
      // Parent has no parent - shouldn't happen for blocks, but guard anyway
      return;
    }
    
    const parentSequence = parentBlock.sequence || 0;
    
    moveNode.mutate({
      id: block.id,
      parentId: grandparentId,
      position: parentSequence + 1, // After parent
    });
  }, [block.id, parentId, parentBlock, moveNode]);
  
  // Handle arrow up navigation - navigate to visually previous block
  // Level-agnostic: works at any nesting depth
  const handleNavigateUp = useCallback((caretX?: number) => {
    // Use visual order (getNextBlockId) to find the block visually above
    let prevBlockId = getNextBlockId(block.id, 'up');
    
    // Fallback: If store doesn't have this block yet (e.g., optimistic updates),
    // use prop-based navigation (previous sibling, or parent if first child)
    if (!prevBlockId) {
      const currentIndex = siblings.findIndex(s => s.id === block.id);
      if (currentIndex > 0) {
        // Previous sibling - but we want the last visible descendant
        const prevSibling = siblings[currentIndex - 1];
        // Find deepest last child (or sibling itself if no visible children)
        prevBlockId = getLastVisibleDescendant(prevSibling);
      } else if (parentBlock && !parentBlock.is_page) {
        // First child - navigate to parent
        prevBlockId = parentBlock.id;
      }
    }
    
    if (!prevBlockId) {
      // No block above to navigate to
      return;
    }
    
    // Find the block data to get its content length for cursor positioning
    const findBlockData = (id: number): Node | null => {
      if (parentBlock && parentBlock.id === id) return parentBlock;
      const sibling = siblings.find(s => s.id === id);
      if (sibling) return sibling;
      // Check nested within siblings
      for (const sib of siblings) {
        if (sib.children) {
          const found = findInTree(sib.children, id);
          if (found) return found;
        }
      }
      return null;
    };
    
    const findInTree = (nodes: Node[], id: number): Node | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = findInTree(node.children, id);
          if (found) return found;
        }
      }
      return null;
    };
    
    // Helper to get last visible descendant of a node
    function getLastVisibleDescendant(node: Node): number {
      // Check if collapsed from node's own property
      const collapsed = node.collapsed ?? false;
      if (collapsed || !node.children || node.children.length === 0) {
        return node.id;
      }
      // Recurse to last child
      const lastChild = node.children[node.children.length - 1];
      return getLastVisibleDescendant(lastChild);
    }
    
    const targetBlock = findBlockData(prevBlockId);
    
    // Position cursor at end of target block - the BlockEditor will use caretX
    // to find the best horizontal position if provided
    const cursorPosition = (targetBlock?.name || '').length;
    setPendingCaret(prevBlockId, cursorPosition, caretX);
    
    setBlockState(prevBlockId, 'edit');
  }, [block.id, getNextBlockId, parentBlock, siblings, setBlockState, setPendingCaret]);
  
  // Handle arrow down navigation - navigate to visually next block
  // Level-agnostic: works at any nesting depth
  const handleNavigateDown = useCallback((caretX?: number) => {
    // Use visual order (getNextBlockId) to find the block visually below
    let nextBlockId = getNextBlockId(block.id, 'down');
    
    // Fallback: If store doesn't have this block yet (e.g., optimistic updates),
    // use prop-based navigation (first child if expanded, or next sibling, or parent's next sibling)
    if (!nextBlockId) {
      // Check if current block is collapsed from its property
      const collapsed = block.collapsed ?? false;
      
      // First: if has visible children, go to first child
      if (!collapsed && children && children.length > 0) {
        nextBlockId = children[0].id;
      } else {
        // Otherwise: try next sibling
        const currentIndex = siblings.findIndex(s => s.id === block.id);
        if (currentIndex >= 0 && currentIndex < siblings.length - 1) {
          nextBlockId = siblings[currentIndex + 1].id;
        }
        // If no next sibling, we'd need parent's next sibling (ancestor walk)
        // This is complex and the store-based navigation handles it better
        // For optimistic blocks, the immediate sibling case is most important
      }
    }
    
    if (!nextBlockId) {
      // No block below to navigate to
      return;
    }
    
    // Set next block to edit mode with cursor at beginning
    // The BlockEditor will use caretX to find the best horizontal position
    setPendingCaret(nextBlockId, 0, caretX);
    setBlockState(nextBlockId, 'edit');
  }, [block.id, block.collapsed, getNextBlockId, children, siblings, setBlockState, setPendingCaret]);

  
  return (
    <div
      ref={containerRef}
      className={classNames}
      style={blockStyle}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
      onClick={handleBlockClick}
      onKeyDown={handleKeyDown}
      data-block-id={block.id}
      data-block-state={blockState}
    >
      {/* Drop indicator - before */}
      {isDragOver && dropPosition === 'before' && (
        <div className="drop-indicator drop-indicator-before" />
      )}
      
      {/* Block row - contains bullet and content on same line */}
      <div className="block-row">
        {/* Bullet - drag handle, context menu anchor, collapse toggle */}
        {showBullet && (
          <Bullet
            nodeId={block.id}
            icon={bulletIcon}
            isPage={false}
            interactive={canMove || canSelect || !!onBulletClick}
            hasChildren={hasChildren}
            collapsed={isCollapsed}
            onDragStart={handleDragStart}
            draggable={canMove && blockState !== 'edit'}
            onClick={handleBulletClickInternal}
            onContextMenu={handleBulletContextMenu}
            onCollapseToggle={handleCollapseToggle}
            showCollapseArrow={hasChildren}
          />
        )}
        
        {/* Block content - fixed width, no placeholder for empty blocks */}
        {/* When suppressColor is true, treat as if there's no color (for focused blocks where color is on container) */}
        <Card 
          className={`block-content${block.color && !suppressColor ? ' block-content--colored' : ''}`}
          style={contentColorStyle} 
          onClick={handleContentClick}
          onFocus={handleFocus}
          elevation="none"
          variant="transparent"
          padding={false}
          radius="none"
        >
          {blockState === 'edit' ? (
            <BlockEditor
              nodeId={block.id}
              isPage={block.is_page}
              nodeUuid={block.uuid}
              content={block.name || ''}
              onChange={(content) => onContentChange?.(block.id, content)}
              editorRef={editorRef}
              onAddClass={onAddClass}
              onAddTag={onAddTag}
              onCreateClass={onCreateClass}
              onCreateTag={onCreateTag}
              onLinkPage={onLinkPage}
              onCreatePageLink={onCreatePageLink}
              onOpenComments={onOpenComments ?? undefined}
              onAssetUpload={onAssetUpload}
              readOnly={!canEdit}
              isTask={Boolean(block.properties?.state)}
              taskState={(block.properties?.state as TaskState) || 'todo'}
              onTaskStateChange={onTaskStateChange ? (newState) => onTaskStateChange(block.id, newState) : undefined}
              onEscape={() => setBlockState(block.id, 'selected')}
              onExtendSelection={extendSelectionKeyboard}
              onEnterCreateBlock={handleEnterCreateBlock}
              onBackspaceAtStart={handleBackspaceAtStart}
              onDeleteAtEnd={handleDeleteAtEnd}
              onIndent={handleIndent}
              onOutdent={handleOutdent}
              onNavigateUp={handleNavigateUp}
              onNavigateDown={handleNavigateDown}
            />
          ) : (
            <div 
              ref={contentRef}
              className={`block-content-view${!block.name ? ' block-content-view--empty' : ''}`}
            >
              {block.name ? (
                <BlockContent
                  content={block.name}
                  blockId={block.id}
                  className="block-content-pills"
                  onDeleteLink={canEdit ? handleDeleteLink : undefined}
                />
              ) : (
                /* Empty block - no placeholder, just maintain width */
                <span className="block-content-empty">&nbsp;</span>
              )}
              {/* Comment indicator in view mode */}
              {commentCount > 0 && (
                <Button 
                  variant="ghost"
                  size="xs"
                  className="block-comment-badge"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenComments?.();
                  }}
                  title={`${commentCount} comment${commentCount > 1 ? 's' : ''}`}
                >
                  💬 {commentCount}
                </Button>
              )}
            </div>
          )}
        </Card>
        
        {/* Block classes - right-aligned */}
        {showTypes && blockClassDetails.length > 0 && (
          <div className="block-types">
            {blockClassDetails.map((classNode) => {
              return (
                <NodeClassPill
                  key={classNode.id}
                  classNode={classNode}
                  onClick={() => openNode(classNode.id, 'page')}
                  onRemove={isSystemClassUuid(classNode.uuid) ? undefined : () => removeClass.mutate({ nodeId: block.id, classId: classNode.id })}
                  readOnly={!canEdit}
                />
              );
            })}
          </div>
        )}
        
        {/* Backlink count badge - right-aligned */}
        {backlinkCount > 0 && (
          <Button 
            variant="ghost"
            size="xs"
            className="block-backlink-badge"
            onClick={(e) => {
              e.stopPropagation();
              onOpenBacklinks?.();
            }}
            title={`${backlinkCount} backlink${backlinkCount > 1 ? 's' : ''}`}
          >
            <span className="block-backlink-badge__count">{backlinkCount}</span>
          </Button>
        )}
      </div>
      
      {/* Drop indicator - after or inside (inside shows as indented line at bottom) */}
      {isDragOver && (dropPosition === 'after' || dropPosition === 'inside') && (
        <div className={`drop-indicator drop-indicator-${dropPosition}`} />
      )}
      
      {/* Children blocks with vertical collapse line */}
      {showChildren && hasChildren && !isCollapsed && (
        <div className="children-container">
          {/* Vertical line for collapsing children */}
          <div 
            className={`children-collapse-line ${isLineHovered ? 'hovered' : ''}`}
            onClick={handleCollapseToggle}
            onMouseEnter={() => setIsLineHovered(true)}
            onMouseLeave={() => setIsLineHovered(false)}
            title="Click to collapse children"
          />
          <div className="nested-blocks">
            {children.map((child) => (
              <Block
                key={child.id}
                block={child}
                children={child.children}
                siblings={children}
                depth={depth + 1}
                parentId={block.id}
                parentBlock={block}
                onContentChange={onContentChange}
                onBulletClick={onBulletClick}
                onShiftClick={onShiftClick}
                onAddClass={onAddClass}
                onAddTag={onAddTag}
                onCreateClass={onCreateClass}
                onCreateTag={onCreateTag}
                onLinkPage={onLinkPage}
                onCreatePageLink={onCreatePageLink}
                onOpenComments={onOpenComments}
                onAssetUpload={onAssetUpload}
                commentCount={child.comment_count}
                backlinkCount={child.backlink_count}
                canMove={canMove}
                canEdit={canEdit}
                canSelect={canSelect}
                onTaskStateChange={onTaskStateChange}
                onOpenBacklinks={onOpenBacklinks}
              />
            ))}
          </div>
        </div>
      )}
      
      {/* Context menu for bullet right-click */}
      {contextMenu && (
        <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 1000 }}>
          <ColorPickerRow 
            currentColor={block.color ?? null} 
            onColorChange={(color) => {
              updateNode.mutate({ id: block.id, data: { color } });
            }} 
          />
          <ContextMenu
            items={contextMenuItems}
            position={{ x: 0, y: 0 }}
            onClose={handleCloseContextMenu}
          />
        </div>
      )}
      
      {/* Deletion confirmation modal */}
      <ConfirmationModal
        isOpen={showDeleteModal}
        title={`Delete ${block.is_page ? 'page' : 'block'}`}
        message={`Are you sure you want to delete "${block.name || 'Untitled'}"? This action cannot be undone.`}
        confirmLabel="Delete permanently"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  );
}

/**
 * PERFORMANCE: Custom comparison for React.memo
 * 
 * Only re-render when render-affecting props change.
 * This prevents cascading re-renders from parent updates.
 * 
 * Props that affect render:
 * - block.id, block.name, block.collapsed, block.color, block.icon
 * - children length (not deep comparison)
 * - depth, canEdit, canMove, canSelect, showBullet, showTypes, showChildren
 * - commentCount, backlinkCount (badges)
 * 
 * Props that DON'T require re-render (callbacks are stable if useCallback'd):
 * - onContentChange, onBulletClick, etc. (should be stable)
 */
function blockPropsAreEqual(
  prevProps: Readonly<BlockProps>,
  nextProps: Readonly<BlockProps>
): boolean {
  // Block identity and content
  if (prevProps.block.id !== nextProps.block.id) return false;
  if (prevProps.block.name !== nextProps.block.name) return false;
  if (prevProps.block.collapsed !== nextProps.block.collapsed) return false;
  if (prevProps.block.color !== nextProps.block.color) return false;
  if (prevProps.block.icon !== nextProps.block.icon) return false;
  if (prevProps.block.sequence !== nextProps.block.sequence) return false;
  
  // Children - shallow compare by length and IDs
  const prevChildren = prevProps.children ?? [];
  const nextChildren = nextProps.children ?? [];
  if (prevChildren.length !== nextChildren.length) return false;
  for (let i = 0; i < prevChildren.length; i++) {
    if (prevChildren[i].id !== nextChildren[i].id) return false;
    // Also check children's names for content updates
    if (prevChildren[i].name !== nextChildren[i].name) return false;
    if (prevChildren[i].collapsed !== nextChildren[i].collapsed) return false;
    if (prevChildren[i].sequence !== nextChildren[i].sequence) return false;
  }
  
  // Siblings - shallow compare by length and IDs (for merge operations)
  const prevSiblings = prevProps.siblings ?? [];
  const nextSiblings = nextProps.siblings ?? [];
  if (prevSiblings.length !== nextSiblings.length) return false;
  for (let i = 0; i < prevSiblings.length; i++) {
    if (prevSiblings[i].id !== nextSiblings[i].id) return false;
    if (prevSiblings[i].name !== nextSiblings[i].name) return false;
  }
  
  // Structural props
  if (prevProps.depth !== nextProps.depth) return false;
  if (prevProps.parentId !== nextProps.parentId) return false;
  
  // Parent block comparison (for merge operations)
  if (prevProps.parentBlock?.id !== nextProps.parentBlock?.id) return false;
  if (prevProps.parentBlock?.name !== nextProps.parentBlock?.name) return false;
  
  // Capability flags
  if (prevProps.canEdit !== nextProps.canEdit) return false;
  if (prevProps.canMove !== nextProps.canMove) return false;
  if (prevProps.canSelect !== nextProps.canSelect) return false;
  if (prevProps.showBullet !== nextProps.showBullet) return false;
  if (prevProps.showTypes !== nextProps.showTypes) return false;
  if (prevProps.showChildren !== nextProps.showChildren) return false;
  if (prevProps.isolatedState !== nextProps.isolatedState) return false;
  if (prevProps.suppressColor !== nextProps.suppressColor) return false;
  
  // Badge counts
  if (prevProps.commentCount !== nextProps.commentCount) return false;
  if (prevProps.backlinkCount !== nextProps.backlinkCount) return false;
  
  // Classes array (shallow ID comparison)
  const prevClasses = prevProps.block.classes ?? prevProps.block.types ?? [];
  const nextClasses = nextProps.block.classes ?? nextProps.block.types ?? [];
  if (prevClasses.length !== nextClasses.length) return false;
  for (let i = 0; i < prevClasses.length; i++) {
    if (prevClasses[i] !== nextClasses[i]) return false;
  }
  
  return true;
}

// Export memoized component as the default Block export for better performance
// The memoization prevents re-renders when only unrelated props change
export const Block = memo(BlockInternal, blockPropsAreEqual);

// Legacy alias for backward compatibility
export const MemoizedBlock = Block;

// Export the non-memoized version for cases where memoization is not desired
export { BlockInternal };

export default Block;
