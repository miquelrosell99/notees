/**
 * Scratchpad Component
 *
 * A floating panel backed by today's daily note.
 * Renders a NodeCollection in list view for multi-level outliner editing.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { mdiPin, mdiPinOff } from '@mdi/js';
import { Button } from '../core/Button';
import { NodeCollection } from '../nodes/NodeCollection';
import { useDailyNote, useNode, useContentSave, useAddClass } from '@/hooks';
import { useNodeNavigation } from '@/hooks';
import type { Node } from '@/types';
import './Scratchpad.css';

interface ScratchpadProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onEntryCountChange?: (count: number) => void;
}

export function Scratchpad({ isOpen, onClose, anchorRef, onEntryCountChange }: ScratchpadProps) {
  const [isPinned, setIsPinned] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch today's daily note (auto-creates if missing)
  const { data: dailyNode } = useDailyNote(new Date());

  // Fetch the daily node with children
  const { data: dailyNodeWithChildren } = useNode(dailyNode?.id ?? null, {
    include_children: true,
  });

  // Block children from the daily note
  const blockChildren = useMemo(() => {
    const node = dailyNodeWithChildren ?? dailyNode;
    if (!node?.children) return [];
    return node.children.filter((c: Node) => !c.is_page);
  }, [dailyNodeWithChildren?.children, dailyNode?.children]);

  // Report entry count to parent
  useEffect(() => {
    onEntryCountChange?.(blockChildren.length);
  }, [blockChildren.length, onEntryCountChange]);

  // Content save for block editing
  const { handleContentChange: handleBlockChange } = useContentSave();
  const addClass = useAddClass();
  const { handleNodeClick, handleNodeShiftClick } = useNodeNavigation();

  const handleAddClass = useCallback((blockId: number, classId: number) => {
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass]);

  // Load pinned state
  useEffect(() => {
    const pinnedState = localStorage.getItem('notees-scratchpad-pinned');
    if (pinnedState === 'true') {
      setIsPinned(true);
    }
  }, []);

  // Position below anchor button when opened
  useEffect(() => {
    if (isOpen && anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const popupWidth = 360;
      const gap = 4;
      let left = rect.right - popupWidth;
      if (left < 8) left = 8;
      if (left + popupWidth > window.innerWidth - 8) {
        left = window.innerWidth - popupWidth - 8;
      }
      setPosition({ x: left, y: rect.bottom + gap });
    } else if (isOpen && !position) {
      setPosition({ x: 100, y: 100 });
    }
  }, [isOpen]);

  // Close on outside click when not pinned
  useEffect(() => {
    if (!isOpen || isPinned) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        (!anchorRef?.current || !anchorRef.current.contains(e.target as Node))
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isPinned, onClose, anchorRef]);

  const handleTogglePin = useCallback(() => {
    setIsPinned(prev => {
      localStorage.setItem('notees-scratchpad-pinned', String(!prev));
      return !prev;
    });
  }, []);

  // Dragging handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget || !position) return;
    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  }, [position]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newPos = {
        x: Math.max(0, Math.min(window.innerWidth - 360, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - 200, e.clientY - dragOffset.current.y)),
      };
      setPosition(newPos);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, position]);

  if (!isOpen && !isPinned) return null;
  if (!position) return null;

  return (
    <div
      ref={containerRef}
      className={`scratchpad ${isDragging ? 'dragging' : ''} ${isPinned ? 'pinned' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div className="scratchpad-header" onMouseDown={handleMouseDown}>
        <span className="scratchpad-title">Scratchpad</span>
        <div className="scratchpad-actions">
          <Button
            className="scratchpad-btn"
            icon={isPinned ? mdiPin : mdiPinOff}
            variant="ghost"
            size="sm"
            active={isPinned}
            onClick={handleTogglePin}
            title={isPinned ? 'Unpin' : 'Pin'}
          />
        </div>
      </div>

      <div className="scratchpad-content">
        {dailyNode ? (
          <NodeCollection
            nodes={blockChildren}
            viewMode="list"
            editable={true}
            onNodeClick={handleNodeClick}
            onNodeShiftClick={handleNodeShiftClick}
            onContentChange={handleBlockChange}
            onAddClass={handleAddClass}
            pageId={dailyNode.id}
            pageUuid={dailyNode.uuid}
            hideToolbar
            showEmpty={false}
          />
        ) : (
          <div className="scratchpad-empty">Loading...</div>
        )}
      </div>
    </div>
  );
}

export default Scratchpad;