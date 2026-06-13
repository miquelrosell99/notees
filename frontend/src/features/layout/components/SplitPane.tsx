/**
 * SplitPane — resizable two-pane split container.
 *
 * Supports horizontal (side-by-side) and vertical (stacked) splits.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import './SplitPane.css';

interface SplitPaneProps {
  orientation: 'horizontal' | 'vertical';
  primary: React.ReactNode;
  secondary: React.ReactNode;
  defaultSplit?: number;
}

export function SplitPane({ orientation, primary, secondary, defaultSplit = 0.5 }: SplitPaneProps) {
  const [split, setSplit] = useState(defaultSplit);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
    document.body.style.cursor = orientation === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [orientation]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let newSplit: number;
      if (orientation === 'horizontal') {
        newSplit = (e.clientX - rect.left) / rect.width;
      } else {
        newSplit = (e.clientY - rect.top) / rect.height;
      }
      newSplit = Math.max(0.2, Math.min(0.8, newSplit));
      setSplit(newSplit);
    };

    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, orientation]);

  const isHorizontal = orientation === 'horizontal';

  return (
    <div
      ref={containerRef}
      className={`split-pane split-pane--${orientation} ${isResizing ? 'split-pane--resizing' : ''}`}
    >
      <div
        className="split-pane__pane split-pane__pane--primary"
        style={{ flex: `0 0 calc(${split * 100}% - var(--spacing-micro))` }}
      >
        {primary}
      </div>
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        role="separator"
        aria-label="Resize panes"
        tabIndex={0}
        className="split-pane__resizer"
        onMouseDown={handleResizeStart}
        title={isHorizontal ? 'Resize (drag)' : 'Resize (drag)'}
        onKeyDown={(e) => {
          const keys = isHorizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
          if (!keys.includes(e.key)) return;
          e.preventDefault();
          setSplit((prev) => {
            const step = 0.05;
            const delta = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? step : -step;
            return Math.max(0.2, Math.min(0.8, prev + delta));
          });
        }}
      />
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        className="split-pane__pane split-pane__pane--secondary"
        style={{ flex: `1 1 auto` }}
      >
        {secondary}
      </div>
    </div>
  );
}
