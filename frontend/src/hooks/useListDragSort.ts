import { useRef, useState, useCallback, useEffect } from 'react';

export interface DragState {
  dragIndex: number;
  targetIndex: number;
  mouseYInContent: number;
  grabOffset: number;
}

export interface UseListDragSortParams {
  itemCount: number;
  itemSelector: string;
  onReorder: (fromIndex: number, toIndex: number) => void;
  preventDefaultOnDragStart?: boolean;
}

export interface UseListDragSortResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  dragState: DragState | null;
  isSettling: boolean;
  handleDragStart: (index: number, e: React.MouseEvent) => void;
  getItemStyle: (index: number) => React.CSSProperties;
}

export function useListDragSort({
  itemCount,
  itemSelector,
  onReorder,
  preventDefaultOnDragStart = false,
}: UseListDragSortParams): UseListDragSortResult {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [isSettling, setIsSettling] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const itemHeightRef = useRef(40);
  const scrollRAF = useRef<number | null>(null);
  const lastClientY = useRef(0);

  // Measure item height
  useEffect(() => {
    if (containerRef.current) {
      const firstItem = containerRef.current.querySelector(itemSelector) as HTMLElement;
      if (firstItem) {
        itemHeightRef.current = firstItem.offsetHeight;
      }
    }
  }, [itemCount, itemSelector]);

  // Handle drag start
  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    if (preventDefaultOnDragStart) {
      e.preventDefault();
    }
    const container = containerRef.current;
    if (!container) return;

    const firstItem = container.querySelector(itemSelector) as HTMLElement;
    if (firstItem) {
      itemHeightRef.current = firstItem.offsetHeight;
    }

    const containerRect = container.getBoundingClientRect();
    const itemTop = index * itemHeightRef.current;
    const mouseYInContent = e.clientY - containerRect.top + container.scrollTop;
    const grabOffset = mouseYInContent - itemTop;

    lastClientY.current = e.clientY;

    setDragState({
      dragIndex: index,
      targetIndex: index,
      mouseYInContent,
      grabOffset,
    });
  }, [itemSelector, preventDefaultOnDragStart]);

  // Main drag effect
  useEffect(() => {
    if (!dragState) return;

    const container = containerRef.current;
    if (!container) return;

    const updateDragPosition = (clientY: number) => {
      const containerRect = container.getBoundingClientRect();
      const mouseYInContent = clientY - containerRect.top + container.scrollTop;

      const itemHeight = itemHeightRef.current;
      const draggedItemTop = mouseYInContent - dragState.grabOffset;
      const draggedItemCenter = draggedItemTop + itemHeight / 2;
      const rawTarget = Math.floor(draggedItemCenter / itemHeight);
      const targetIndex = Math.max(0, Math.min(itemCount - 1, rawTarget));

      setDragState(prev => prev ? {
        ...prev,
        mouseYInContent,
        targetIndex,
      } : null);

      return { containerRect, mouseYInContent };
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastClientY.current = e.clientY;
      const { containerRect } = updateDragPosition(e.clientY);

      const scrollZone = 40;
      const maxSpeed = 6;

      const distFromTop = e.clientY - containerRect.top;
      const distFromBottom = containerRect.bottom - e.clientY;

      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const canScrollUp = container.scrollTop > 0;
      const canScrollDown = container.scrollTop < container.scrollHeight - container.clientHeight;

      if (distFromTop < scrollZone && canScrollUp) {
        const speed = Math.ceil(((scrollZone - distFromTop) / scrollZone) * maxSpeed);

        const doScroll = () => {
          if (container.scrollTop > 0) {
            container.scrollTop -= speed;
            updateDragPosition(lastClientY.current);
            scrollRAF.current = requestAnimationFrame(doScroll);
          }
        };
        scrollRAF.current = requestAnimationFrame(doScroll);

      } else if (distFromBottom < scrollZone && canScrollDown) {
        const speed = Math.ceil(((scrollZone - distFromBottom) / scrollZone) * maxSpeed);

        const doScroll = () => {
          if (container.scrollTop < container.scrollHeight - container.clientHeight) {
            container.scrollTop += speed;
            updateDragPosition(lastClientY.current);
            scrollRAF.current = requestAnimationFrame(doScroll);
          }
        };
        scrollRAF.current = requestAnimationFrame(doScroll);
      }
    };

    const handleMouseUp = () => {
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const { dragIndex, targetIndex } = dragState;

      setIsSettling(true);
      setDragState(null);

      if (dragIndex !== targetIndex) {
        onReorder(dragIndex, targetIndex);
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsSettling(false);
        });
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }
    };
  }, [dragState, itemCount, onReorder]);

  // Get transform style for each item
  const getItemStyle = useCallback((index: number): React.CSSProperties => {
    if (!dragState) return {};

    const { dragIndex, targetIndex, mouseYInContent, grabOffset } = dragState;
    const itemHeight = itemHeightRef.current;

    if (index === dragIndex) {
      const naturalTop = dragIndex * itemHeight;
      const desiredTop = mouseYInContent - grabOffset;
      const minTop = 0;
      const maxTop = (itemCount - 1) * itemHeight;
      const clampedTop = Math.max(minTop, Math.min(maxTop, desiredTop));
      const translateY = clampedTop - naturalTop;

      return {
        transform: `translateY(${translateY}px)`,
        zIndex: 100,
        transition: 'none',
      };
    }

    let shift = 0;

    if (dragIndex < targetIndex) {
      if (index > dragIndex && index <= targetIndex) {
        shift = -itemHeight;
      }
    } else if (dragIndex > targetIndex) {
      if (index >= targetIndex && index < dragIndex) {
        shift = itemHeight;
      }
    }

    return {
      transform: shift !== 0 ? `translateY(${shift}px)` : undefined,
      zIndex: 1,
      transition: isSettling ? 'none' : 'transform 150ms ease-out',
    };
  }, [dragState, isSettling, itemCount]);

  return {
    containerRef,
    dragState,
    isSettling,
    handleDragStart,
    getItemStyle,
  };
}
