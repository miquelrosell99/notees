/**
 * MainContentTopbar Component
 * 
 * Shared topbar component used by NodeView and PropertyView.
 * Provides a consistent header structure with left/center/right sections.
 */
import { ReactNode } from 'react';
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
}

export function MainContentTopbar({ left, center, right, className = '' }: MainContentTopbarProps) {
  return (
    <div className={`main-content-header ${className}`}>
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
