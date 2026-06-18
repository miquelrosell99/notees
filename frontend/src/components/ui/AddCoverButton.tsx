/**
 * AddCoverButton Component
 * 
 * Reusable button for adding cover images to nodes.
 * Used in card views, table views, and anywhere a cover placeholder is needed.
 * Supports drag and drop of image files.
 */
import { useState } from 'react';

import './AddCoverButton.css';
import { Icon } from '@/components/ui/icons';

export interface AddCoverButtonProps {
  /** Callback when the button is clicked */
  onClick: () => void;
  /** Callback when a file is dropped (receives a File object or URL string) */
  onDrop?: (file: File | string) => void;
  /** Optional drop processor that extracts a file/URL from the raw drag event */
  processDrop?: (e: React.DragEvent) => Promise<{ file: File | string } | null | undefined>;
  /** Optional CSS class */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Display variant (e.g. inside a card cover thumbnail). */
  variant?: 'default' | 'card-cover';
}

export function AddCoverButton({
  onClick,
  onDrop,
  processDrop,
  className = '',
  size = 'md',
  variant = 'default',
}: AddCoverButtonProps) {
  const [isDragging, setIsDragging] = useState(false);
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (!onDrop) return;
    e.stopPropagation();

    try {
      if (processDrop) {
        const result = await processDrop(e);
        if (result) {
          onDrop(result.file);
        }
      }
    } catch (error) {
      console.error('Failed to process dropped image:', error);
    }
  };
  
  return (
    <button
      className={`add-cover-button add-cover-button--${size} ${isDragging ? 'add-cover-button--dragging' : ''} ${className}`}
      data-variant={variant}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      type="button"
      aria-label="Add cover image"
    >
      <Icon path={"mdi mdi-image-plus"} size={size === 'sm' ? 0.8 : size === 'lg' ? 1.2 : 1} />
      <span className="add-cover-button__text">
        {isDragging ? 'Drop image here' : 'Add cover'}
      </span>
    </button>
  );
}
