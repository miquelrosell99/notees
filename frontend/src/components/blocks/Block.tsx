/**
 * Block Component
 * 
 * Block component with 3 states: display, edit, selected (mutually exclusive)
 * 
 * Component Hierarchy:
 * Block
 *  ├─ BlockContainer   (layout, indent, selection state)
 *  ├─ BlockBullet      (Bullet component - drag handle, expand/collapse)
 *  ├─ BlockContent     (view mode - text with LinkPill/TypePill tokens)
 *  │    ├─ TextToken
 *  │    ├─ LinkPill
 *  │    └─ TypePill
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
import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useBlockSelectionStore, type BlockState } from '@/stores/blockSelectionStore';
import { useMoveNode, useUpdateNode, useDeleteNode, useCreateNode, useTypes, useRemoveType } from '@/hooks';
import { useNodesStore } from '@/stores';
import { BlockEditor, type TaskState } from './BlockEditor';
import { BlockContent } from './BlockContent';
import { Bullet } from './Bullet';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { ContextMenu } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { ColorPickerRow } from '../nodes/NodeContextMenu';
import { NodeTypePill } from '../NodeTypePill';
import { NodeIcon } from '../icons';
import { SYSTEM_TYPE_UUIDS, isSystemTypeUuid } from '@/constants';
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
  onAddType?: (typeNodeId: number, keepInline: boolean, typeName: string) => void;
  onAddTag?: (tagNodeId: number, keepInline: boolean, tagName: string) => void;
  onCreateType?: (name: string, keepInline: boolean) => void;
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

export function Block({
  block,
  children = [],
  siblings = [],
  depth = 0,
  parentId,
  parentBlock,
  onContentChange,
  onBulletClick,
  onShiftClick,
  onAddType,
  onAddTag,
  onCreateType,
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
  const [initialCursorPosition, setInitialCursorPosition] = useState<number | undefined>(undefined);
  
  // Local state for isolated mode (blocks that appear in multiple places like linked references)
  const [localBlockState, setLocalBlockState] = useState<BlockState>('display');
  
  const moveNode = useMoveNode();
  const updateNode = useUpdateNode();
  const deleteNode = useDeleteNode();
  const createNode = useCreateNode();
  const removeType = useRemoveType();
  const { data: allTypes } = useTypes();
  const { openNode } = useNodesStore();
  
  // Resolve type details from IDs (excluding the implicit "page" type)
  const blockTypeDetails = useMemo(() => {
    if (!block.types || block.types.length === 0 || !allTypes) return [];
    return block.types
      .map(typeId => allTypes.find(t => t.id === typeId))
      .filter((t): t is Node => t !== undefined && t.uuid !== SYSTEM_TYPE_UUIDS.page);
  }, [block.types, allTypes]);
  
  // Determine the icon to show on the bullet
  // Priority: first type's icon > block's own icon
  const bulletIcon = useMemo(() => {
    // If block has types with icons, use the first type's icon
    if (blockTypeDetails.length > 0) {
      const firstTypeWithIcon = blockTypeDetails.find(t => t.icon);
      if (firstTypeWithIcon?.icon) {
        return firstTypeWithIcon.icon;
      }
    }
    // Fall back to block's own icon
    return block.icon;
  }, [blockTypeDetails, block.icon]);
  
  // Determine if block has children
  const hasChildren = children && children.length > 0;
  const isCollapsed = block.collapsed ?? false;
  
  const {
    selectedBlockIds,
    primarySelectedBlockId,
    selectionMode,
    dragState,
    selectBlock,
    addToSelection,
    startDrag,
    updateDragTarget,
    endDrag,
    registerBlock,
    unregisterBlock,
    getNextBlockId,
    getBlockState,
    setBlockState: setGlobalBlockState,
    extendSelectionKeyboard,
    blockParentMap,
    clearSelection,
  } = useBlockSelectionStore();
  
  // Get block state - use local state for isolated blocks, global state otherwise
  // If canEdit is false, always stay in display state
  const globalBlockState: BlockState = !canEdit ? 'display' : getBlockState(block.id);
  const blockState: BlockState = isolatedState ? localBlockState : globalBlockState;
  
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
  const isSelected = (isolatedState || !canSelect) ? false : selectedBlockIds.has(block.id);
  const isPrimarySelected = (isolatedState || !canSelect) ? false : primarySelectedBlockId === block.id;
  const isEditing = blockState === 'edit';
  const isBeingDragged = (isolatedState || !canMove) ? false : dragState.draggedBlockIds.includes(block.id);
  
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
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
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
    
    // Calculate cursor position from click
    const cursorPos = getCursorPositionFromClick(e);
    console.log('[Block] handleContentClick - cursorPos:', cursorPos, 'content:', block.name?.substring(0, 50));
    setInitialCursorPosition(cursorPos);
    
    // Enter edit mode
    setBlockState(block.id, 'edit');
  }, [block.id, block.name, canEdit, setBlockState, getCursorPositionFromClick]);
  
  // Reset initial cursor position when entering edit mode (after a short delay to allow it to be applied)
  useEffect(() => {
    if (blockState === 'edit' && initialCursorPosition !== undefined) {
      // Clear after a short delay to allow the editor to apply it
      const timer = setTimeout(() => {
        setInitialCursorPosition(undefined);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [blockState, initialCursorPosition]);
  
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
          // Set the new block to edit mode
          setBlockState(newNode.id, 'edit');
        },
      }
    );
  }, [block.id, block.name, block.sequence, hasChildren, parentId, updateNode, createNode, setBlockState]);
  
  // Handle Backspace at start of block - merge text with block above
  const handleBackspaceAtStart = useCallback((remainingText: string) => {
    // Find the block above us: first try previous sibling, then parent
    const currentIndex = siblings.findIndex(s => s.id === block.id);
    const prevSibling = currentIndex > 0 ? siblings[currentIndex - 1] : null;
    
    // Target is either previous sibling or parent block
    const targetBlock = prevSibling || parentBlock;
    
    if (!targetBlock) {
      // No block above to merge into
      return;
    }
    
    // Append remaining text to target block's content
    const targetContent = targetBlock.name || '';
    const mergedContent = targetContent + remainingText;
    
    // Update target block with merged content
    updateNode.mutate({
      id: targetBlock.id,
      data: { name: mergedContent }
    });
    
    // Delete current block
    deleteNode.mutate(block.id);
    
    // Set target block to edit mode (cursor will be at end due to content change)
    setBlockState(targetBlock.id, 'edit');
  }, [block.id, siblings, parentBlock, updateNode, deleteNode, setBlockState]);
  
  // Handle Delete at end of block - merge next sibling's text into current
  const handleDeleteAtEnd = useCallback(() => {
    // Find the next sibling
    const currentIndex = siblings.findIndex(s => s.id === block.id);
    const nextSibling = currentIndex >= 0 && currentIndex < siblings.length - 1 
      ? siblings[currentIndex + 1] 
      : null;
    
    if (!nextSibling) {
      // No sibling to merge
      return;
    }
    
    // Check if the next sibling has children
    const nextSiblingHasChildren = nextSibling.children && nextSibling.children.length > 0;
    if (nextSiblingHasChildren) {
      // Next sibling has children, don't merge
      return;
    }
    
    // Append next sibling's content to current block
    const currentContent = block.name || '';
    const siblingContent = nextSibling.name || '';
    const mergedContent = currentContent + siblingContent;
    
    // Update current block with merged content
    updateNode.mutate({
      id: block.id,
      data: { name: mergedContent }
    });
    
    // Delete the next sibling
    deleteNode.mutate(nextSibling.id);
  }, [block.id, block.name, siblings, updateNode, deleteNode]);
  
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
  
  // Handle arrow up navigation - move to previous sibling block
  const handleNavigateUp = useCallback(() => {
    if (!editorRef.current) return;
    
    const currentIndex = siblings.findIndex(s => s.id === block.id);
    const prevSibling = currentIndex > 0 ? siblings[currentIndex - 1] : null;
    
    // Target is either previous sibling or parent block
    const targetBlock = prevSibling || parentBlock;
    
    if (!targetBlock) {
      // No block above to navigate to
      return;
    }
    
    // Get the current cursor's horizontal position
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const horizontalOffset = rect.left;
      
      // Store the horizontal offset for positioning in the target block
      // We'll use a data attribute or context, but for simplicity, calculate target position
      // Position cursor at end of target block for now (simpler and common behavior)
      const cursorPosition = (targetBlock.name || '').length;
      setInitialCursorPosition(cursorPosition);
    } else {
      setInitialCursorPosition((targetBlock.name || '').length);
    }
    
    setBlockState(targetBlock.id, 'edit');
  }, [siblings, parentBlock, setBlockState, block.id, editorRef]);
  
  // Handle arrow down navigation - move to next sibling block
  const handleNavigateDown = useCallback(() => {
    const currentIndex = siblings.findIndex(s => s.id === block.id);
    const nextSibling = currentIndex >= 0 && currentIndex < siblings.length - 1 
      ? siblings[currentIndex + 1] 
      : null;
    
    if (!nextSibling) {
      // Try to navigate to first child if current block has children
      if (children.length > 0) {
        const firstChild = children[0];
        setInitialCursorPosition(0);
        setBlockState(firstChild.id, 'edit');
        return;
      }
      // No block below to navigate to
      return;
    }
    
    // Set next sibling to edit mode with cursor at beginning
    setInitialCursorPosition(0);
    setBlockState(nextSibling.id, 'edit');
  }, [siblings, children, setBlockState]);

  
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
            interactive={canMove || canSelect}
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
              onChange={(content) => onContentChange(block.id, content)}
              initialCursorPosition={initialCursorPosition}
              editorRef={editorRef}
              onAddType={onAddType}
              onAddTag={onAddTag}
              onCreateType={onCreateType}
              onCreateTag={onCreateTag}
              onLinkPage={onLinkPage}
              onCreatePageLink={onCreatePageLink}
              onOpenComments={onOpenComments}
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
        
        {/* Block types - right-aligned */}
        {showTypes && blockTypeDetails.length > 0 && (
          <div className="block-types">
            {blockTypeDetails.map((typeNode) => {
              return (
                <NodeTypePill
                  key={typeNode.id}
                  typeNode={typeNode}
                  onClick={() => openNode(typeNode.id, 'page')}
                  onRemove={isSystemTypeUuid(typeNode.uuid) ? undefined : () => removeType.mutate({ nodeId: block.id, typeId: typeNode.id })}
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
                onAddType={onAddType}
                onAddTag={onAddTag}
                onCreateType={onCreateType}
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

export default Block;
