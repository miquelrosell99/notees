/**
 * MainContentTopbar Component
 * 
 * Shared topbar component used by NodeView and PropertyView.
 * Provides a consistent header structure with left/center/right sections.
 */
import type { ReactNode } from 'react';
import './MainContentTopbar.css';

interface MainContentTopbarProps {
  /** Content for the left section (e.g., breadcrumbs) */
  left?: ReactNode;
  /** Content for the center section */
  center?: ReactNode;
  /** Content for the right section (e.g., controls) */
  right?: ReactNode;
  /** Additional CSS class name */
  className?: string;
  /** Whether focus mode is active. */
  focusMode?: boolean;
}

export function MainContentTopbar({ left, center, right, className = '', focusMode }: MainContentTopbarProps) {
  return (
    <div className={`main-content-header ${className}`} data-focus-mode={focusMode || undefined}>
      <div className="node-view-header-content">
        <div className="node-view-header-left">
          {left}
        </div>
        <div className="node-view-header-center">
          {center}
        </div>
        <div className="node-view-header-right">
          {right}
        </div>
      </div>
    </div>
  );
}
