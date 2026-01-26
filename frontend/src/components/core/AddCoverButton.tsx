/**
 * AddCoverButton Component
 * 
 * Reusable button for adding cover images to nodes.
 * Used in card views, table views, and anywhere a cover placeholder is needed.
 */
import { mdiImagePlus } from '@mdi/js';
import Icon from '@mdi/react';
import './AddCoverButton.css';

export interface AddCoverButtonProps {
  /** Callback when the button is clicked */
  onClick: () => void;
  /** Optional CSS class */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

export function AddCoverButton({ 
  onClick, 
  className = '', 
  size = 'md' 
}: AddCoverButtonProps) {
  return (
    <button 
      className={`add-cover-button add-cover-button--${size} ${className}`}
      onClick={onClick}
      type="button"
      aria-label="Add cover image"
    >
      <Icon path={mdiImagePlus} size={size === 'sm' ? 0.8 : size === 'lg' ? 1.2 : 1} />
      <span className="add-cover-button__text">Add cover</span>
    </button>
  );
}
