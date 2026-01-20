/**
 * BoxSelect Component
 * 
 * Allows users to select multiple blocks by drawing a selection box.
 * Click and drag on empty space to create a selection rectangle.
 * Any blocks touching the rectangle get selected.
 */
import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import './BoxSelect.css';

interface BoxSelectProps {
  /** Container element ref to scope selection */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Whether box selection is enabled */
  enabled?: boolean;
  /** Callback when selection changes */
  onSelectionChange?: (selectedIds: number[]) => void;
}

/**
 * Check if two rectangles intersect
 */
function rectsIntersect(
  r1: { left: number; top: number; right: number; bottom: number },
  r2: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(
    r1.right < r2.left ||
    r1.left > r2.right ||
    r1.bottom < r2.top ||
    r1.top > r2.bottom
  );
}

/**
 * Get normalized rectangle (handles negative dimensions)
 */
function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const right = Math.max(startX, endX);
  const bottom = Math.max(startY, endY);
  
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function BoxSelect({
  containerRef,
  enabled = true,
  onSelectionChange,
}: BoxSelectProps) {
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  
  const {
    blockElements,
    startBoxSelect,
    updateBoxSelect,
    endBoxSelect,
    selectBlocks,
    clearSelection,
  } = useBlockSelectionStore();
  
  // Start position (relative to container)
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  
  /**
   * Handle mouse down - start box selection if clicking on empty space
   */
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (!enabled || !containerRef.current) return;
    
    // Only left click
    if (e.button !== 0) return;
    
    // Check if clicking on empty space (not on a block or interactive element)
    const target = e.target as HTMLElement;
    const isOnBlock = target.closest('[data-block-id]');
    const isOnInteractive = target.closest('button, input, textarea, a, [role="button"]');
    
    if (isOnBlock || isOnInteractive) return;
    
    // Check if click is within container
    if (!containerRef.current.contains(target)) return;
    
    // Start selection
    const containerRect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - containerRect.left + containerRef.current.scrollLeft;
    const y = e.clientY - containerRect.top + containerRef.current.scrollTop;
    
    startPosRef.current = { x, y };
    startBoxSelect(x, y);
    setIsSelecting(true);
    
    // Clear existing selection
    clearSelection();
    
    // Prevent text selection
    e.preventDefault();
  }, [clearSelection, containerRef, enabled, startBoxSelect]);
  
  /**
   * Handle mouse move - update selection box
   */
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isSelecting || !startPosRef.current || !containerRef.current) return;
    
    const containerRect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - containerRect.left + containerRef.current.scrollLeft;
    const y = e.clientY - containerRect.top + containerRef.current.scrollTop;
    
    updateBoxSelect(x, y);
    
    // Update visual selection box
    const rect = normalizeRect(
      startPosRef.current.x,
      startPosRef.current.y,
      x,
      y
    );
    
    setSelectionRect({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    
    // Find blocks intersecting with selection box
    const containerOffset = {
      left: containerRect.left - containerRef.current.scrollLeft,
      top: containerRect.top - containerRef.current.scrollTop,
    };
    
    const selectedIds: number[] = [];
    
    blockElements.forEach((element, blockId) => {
      const blockRect = element.getBoundingClientRect();
      
      // Convert block rect to container-relative coordinates
      const relativeBlockRect = {
        left: blockRect.left - containerOffset.left,
        top: blockRect.top - containerOffset.top,
        right: blockRect.right - containerOffset.left,
        bottom: blockRect.bottom - containerOffset.top,
      };
      
      // Convert selection rect to same coordinate space
      const selectionRectAbsolute = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
      
      if (rectsIntersect(selectionRectAbsolute, relativeBlockRect)) {
        selectedIds.push(blockId);
      }
    });
    
    // Update selection
    selectBlocks(selectedIds);
    onSelectionChange?.(selectedIds);
  }, [blockElements, containerRef, isSelecting, onSelectionChange, selectBlocks, updateBoxSelect]);
  
  /**
   * Handle mouse up - end box selection
   */
  const handleMouseUp = useCallback(() => {
    if (!isSelecting) return;
    
    setIsSelecting(false);
    setSelectionRect(null);
    startPosRef.current = null;
    endBoxSelect();
  }, [endBoxSelect, isSelecting]);
  
  // Add event listeners
  useEffect(() => {
    if (!enabled) return;
    
    const container = containerRef.current;
    if (!container) return;
    
    // Mouse down on container
    container.addEventListener('mousedown', handleMouseDown);
    
    // Mouse move and up on window (to handle dragging outside container)
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, containerRef, handleMouseDown, handleMouseMove, handleMouseUp]);
  
  // Don't render anything if not selecting
  if (!isSelecting || !selectionRect) return null;
  
  return (
    <div
      ref={selectionBoxRef}
      className="box-select-overlay"
      style={{
        left: selectionRect.left,
        top: selectionRect.top,
        width: selectionRect.width,
        height: selectionRect.height,
      }}
    />
  );
}

export default BoxSelect;
